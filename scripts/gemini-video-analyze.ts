#!/usr/bin/env tsx

/**
 * Gemini Video Analyzer
 *
 * Sends a QA screen recording to Gemini and writes a markdown report:
 * timestamps, UI transitions, errors, dropdown values, GraphQL activity.
 *
 * Usage:
 *   npx tsx scripts/gemini-video-analyze.ts <video-path> [options]
 *
 * Options:
 *   --ticket <ID>              Jira ticket ID to include in the analysis
 *   --detail <level>           Analysis detail: quick | detailed | exhaustive (default: detailed)
 *   --output <dir>             Output directory (default: same as video)
 *   --help, -h                 Show this help message
 *
 * Examples:
 *   npx tsx scripts/gemini-video-analyze.ts ~/Desktop/recording.mov
 *   npx tsx scripts/gemini-video-analyze.ts video.mov --ticket PROJ-123 --detail exhaustive
 *   npx tsx scripts/gemini-video-analyze.ts video.mov --output dailies/2026-01-12/
 *
 * Requires:
 *   GEMINI_API_KEY environment variable (get from https://aistudio.google.com/apikey)
 *
 * Cost:
 *   ~$0.05-0.10 per 60-90 second video in frame mode (default)
 *   ~$0.02-0.04 in video mode (--video-mode). Free tier: 1,500 requests/day.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, basename, dirname, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// @google/genai type definitions (to avoid full import if not installed yet)
type GoogleGenAI = any;
type UploadedFile = any;

interface CliOptions {
  videoPath: string;
  ticketId?: string;
  detailLevel: 'quick' | 'detailed' | 'exhaustive';
  outputDir?: string;
  useFrames?: boolean; // Frame extraction mode for accurate UI text reading
  fps?: number; // Frames per second to extract (default: 1)
}

interface CriticalMoment {
  timestamp: string;
  description: string;
  severity: 'critical' | 'high' | 'normal';
}

interface VideoAnalysisResult {
  summary: string;
  criticalMoments: CriticalMoment[];
  uiStateTransitions: string[];
  errorsFound: string[];
  graphqlActivity: string[];
  dropdownSelections: string[];
  recommendations: string[];
  rawAnalysis: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
}

class GeminiVideoAnalyzer {
  private ai: GoogleGenAI;
  private apiKey: string;
  private initialized: boolean = false;

  // Gemini 2.5 Flash pricing (as of 2026)
  private readonly PRICE_PER_1M_INPUT_TOKENS = 0.075;  // $0.075 per 1M tokens
  private readonly PRICE_PER_1M_OUTPUT_TOKENS = 0.30;  // $0.30 per 1M tokens

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';

    if (!this.apiKey || this.apiKey === 'your_api_key_here_replace_this_text') {
      throw new Error(
        'GEMINI_API_KEY not found or not set.\n\n' +
        'Please:\n' +
        '1. Get your API key from https://aistudio.google.com/apikey\n' +
        '2. Add it to .env file: GEMINI_API_KEY=your_actual_key_here\n' +
        '3. Or set environment variable: export GEMINI_API_KEY=your_key'
      );
    }
  }

  private calculateCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * this.PRICE_PER_1M_INPUT_TOKENS;
    const outputCost = (outputTokens / 1_000_000) * this.PRICE_PER_1M_OUTPUT_TOKENS;
    return inputCost + outputCost;
  }

  private async initialize() {
    if (this.initialized) return;

    try {
      const genai = await import('@google/genai');
      this.ai = new genai.GoogleGenAI({ apiKey: this.apiKey });
      this.initialized = true;
    } catch (error) {
      throw new Error(
        'Failed to load @google/genai package.\n\n' +
        'Please run: npm install\n\n' +
        'Original error: ' + (error as Error).message
      );
    }
  }

  async analyzeVideo(options: CliOptions): Promise<VideoAnalysisResult> {
    await this.initialize();

    if (options.useFrames) {
      return this.analyzeVideoFrames(options);
    }

    console.log(`[upload] Uploading video: ${basename(options.videoPath)}`);

    const stats = statSync(options.videoPath);
    const sizeMB = stats.size / (1024 * 1024);
    console.log(`   Size: ${sizeMB.toFixed(2)} MB`);

    if (sizeMB > 2000) {
      throw new Error(`Video size (${sizeMB.toFixed(2)} MB) exceeds 2GB limit`);
    }

    const uploadedFile = await this.uploadVideo(options.videoPath);
    console.log(`[done] Upload complete: ${uploadedFile.name}`);

    await this.waitForProcessing(uploadedFile.name);

    const prompt = this.buildPrompt(options);

    console.log(`[analyze] Analyzing video (${options.detailLevel} mode)...`);
    console.log(`   Model: gemini-2.5-flash (stable)`);

    const { text: response, usage } = await this.generateContent(uploadedFile, prompt);

    await this.deleteFile(uploadedFile.name);
    console.log(`[done] Cleanup complete`);

    const result = this.parseAnalysis(response);
    result.usage = usage;

    return result;
  }

  private async analyzeVideoFrames(options: CliOptions): Promise<VideoAnalysisResult> {
    console.log(`[frames] Frame extraction mode`);
    console.log(`   Video: ${basename(options.videoPath)}`);

    const tempDir = join(dirname(options.videoPath), '.frames-temp-' + Date.now());
    mkdirSync(tempDir, { recursive: true });

    try {
      const framePaths = this.extractFrames(options.videoPath, tempDir, options.fps || 1);
      console.log(`[done] Extracted ${framePaths.length} frames`);

      console.log(`[analyze] Analyzing frames (${options.detailLevel} mode)...`);
      console.log(`   Model: gemini-2.5-flash (stable)`);

      const { text: response, usage } = await this.analyzeFrames(framePaths, options);

      const result = this.parseAnalysis(response);
      result.usage = usage;

      return result;
    } finally {
      this.cleanupTempDir(tempDir);
      console.log(`[done] Cleanup complete`);
    }
  }

  private extractFrames(videoPath: string, outputDir: string, fps: number): string[] {
    console.log(`[extract] Extracting frames at ${fps} fps...`);

    try {
      const outputPattern = join(outputDir, 'frame_%04d.png');
      execFileSync('ffmpeg', [
        '-i', videoPath,
        '-vf', `fps=${fps},scale=1200:-1`,
        outputPattern,
        '-y'
      ], { stdio: 'pipe' });

      const frames = readdirSync(outputDir)
        .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
        .sort()
        .map(f => join(outputDir, f));

      return frames;
    } catch (error) {
      throw new Error(`Frame extraction failed: ${(error as Error).message}`);
    }
  }

  private async analyzeFrames(framePaths: string[], options: CliOptions): Promise<{ text: string; usage?: any }> {
    const genai = await import('@google/genai');
    const { createUserContent, createPartFromUri } = genai;

    // Upload frames in parallel batches to avoid sequential HTTP round-trips
    console.log(`[upload] Uploading ${framePaths.length} frames...`);
    const uploadedFrames: UploadedFile[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < framePaths.length; i += BATCH_SIZE) {
      const batch = framePaths.slice(i, i + BATCH_SIZE);
      const uploaded = await Promise.all(
        batch.map(framePath => this.ai.files.upload({
          file: framePath,
          config: { mimeType: 'image/png' }
        }))
      );
      uploadedFrames.push(...uploaded);
    }

    console.log(`[done] All frames uploaded`);

    const prompt = this.buildFramePrompt(options, framePaths.length);
    const frameParts = uploadedFrames.map(frame =>
      createPartFromUri(frame.uri, frame.mimeType)
    );

    try {
      const response = await this.ai.models.generateContent({
        model: 'models/gemini-2.5-flash',
        contents: createUserContent([...frameParts, prompt])
      });

      const usage = response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata.totalTokenCount || 0,
        estimatedCost: this.calculateCost(
          response.usageMetadata.promptTokenCount || 0,
          response.usageMetadata.candidatesTokenCount || 0
        )
      } : undefined;

      return {
        text: response.text || '',
        usage
      };
    } finally {
      // Clean up uploaded frames regardless of success or failure
      for (const frame of uploadedFrames) {
        await this.deleteFile(frame.name);
      }
    }
  }

  private buildFramePrompt(options: CliOptions, frameCount: number): string {
    const basePrompt = `You are analyzing ${frameCount} sequential frames extracted from a QA testing video. Each frame represents a moment in time (at ${options.fps || 1} FPS).

**Frame Analysis Instructions:**

1. **Read UI text exactly** - Don't infer or assume. Quote what you actually see in each frame.

2. **Track changes between frames** - Note when UI elements appear, disappear, or change.

3. **Identify frame numbers** - Reference frames by their position (Frame 1, Frame 5, etc.).

4. **Calculate timestamps** - Frame N = (N-1) / ${options.fps || 1} seconds (e.g., Frame 5 at 1fps = 00:04)

5. **Focus on state changes:**
   - Button state changes (enabled/disabled)
   - Text content changes (especially in tables, forms, dropdowns)
   - Modal open/close
   - Loading indicators
   - Error messages
   - Success toasts

Provide your analysis using these markdown sections: Executive Summary, Critical Moments, UI State Transitions, Errors & Validation, Dropdown Selections & Data Entry, GraphQL Activity, Observations & Recommendations. Reference frame numbers and calculated timestamps instead of video timecodes.

${options.ticketId ? `\n**Context:** This video is testing Jira ticket ${options.ticketId}.` : ''}
`;

    return basePrompt;
  }

  private cleanupTempDir(dirPath: string): void {
    try {
      const files = readdirSync(dirPath);
      for (const file of files) {
        unlinkSync(join(dirPath, file));
      }
      rmdirSync(dirPath);
    } catch (error) {
      console.warn(`[warn] Failed to cleanup temp directory: ${(error as Error).message}`);
    }
  }

  private async uploadVideo(videoPath: string): Promise<UploadedFile> {
    try {
      // Detect mime type from extension
      const ext = extname(videoPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.mov': 'video/quicktime',
        '.mp4': 'video/mp4',
        '.avi': 'video/x-msvideo',
        '.webm': 'video/webm'
      };

      const mimeType = mimeTypes[ext] || 'video/mp4';

      const uploadedFile = await this.ai.files.upload({
        file: videoPath,
        config: { mimeType }
      });

      return uploadedFile;
    } catch (error) {
      throw new Error(`Video upload failed: ${(error as Error).message}`);
    }
  }

  private async waitForProcessing(fileName: string): Promise<void> {
    console.log(`[wait] Waiting for video processing...`);

    let attempts = 0;
    const maxAttempts = 60; // 2 minutes max

    while (attempts < maxAttempts) {
      const file = await this.ai.files.get({ name: fileName });

      if (file.state === 'ACTIVE') {
        console.log(`[done] Processing complete`);
        return;
      }

      if (file.state === 'FAILED') {
        throw new Error(`Video processing failed: ${file.error?.message || 'Unknown error'}`);
      }

      // Still processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;

      if (attempts % 5 === 0) {
        console.log(`   Still processing... (${attempts * 2}s elapsed)`);
      }
    }

    throw new Error('Video processing timeout (exceeded 2 minutes)');
  }

  private async generateContent(uploadedFile: UploadedFile, prompt: string): Promise<{ text: string; usage?: any }> {
    try {
      const genai = await import('@google/genai');
      const { createUserContent, createPartFromUri } = genai;

      const response = await this.ai.models.generateContent({
        model: 'models/gemini-2.5-flash',
        contents: createUserContent([
          createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
          prompt
        ])
      });

      const usage = response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata.totalTokenCount || 0,
        estimatedCost: this.calculateCost(
          response.usageMetadata.promptTokenCount || 0,
          response.usageMetadata.candidatesTokenCount || 0
        )
      } : undefined;

      return {
        text: response.text || '',
        usage
      };
    } catch (error) {
      throw new Error(`Analysis generation failed: ${(error as Error).message}`);
    }
  }

  private async deleteFile(fileName: string): Promise<void> {
    try {
      await this.ai.files.delete({ name: fileName });
    } catch (error) {
      console.warn(`[warn] Failed to delete file: ${(error as Error).message}`);
    }
  }

  private buildPrompt(options: CliOptions): string {
    const detailInstructions: Record<string, string> = {
      quick: 'Provide a brief 3-5 sentence summary focusing only on critical issues.',
      detailed: 'Provide comprehensive analysis with timestamps and detailed observations.',
      exhaustive: 'Provide exhaustive frame-by-frame analysis with every UI change documented.'
    };

    const basePrompt = `You are analyzing a QA testing video for a web application. This video shows manual testing of features.

**Analysis Level:** ${detailInstructions[options.detailLevel]}

Analyze this video and provide your response in the following markdown format:

## Executive Summary
[2-3 sentences summarizing: what feature/workflow is being tested, key actions observed, overall assessment]

## Critical Moments
[List important moments with timestamps in format MM:SS or M:SS]

**Example format:**
- **00:15** - [CRITICAL] Backend error not displayed to user (silent failure)
- **01:23** - [HIGH] Validation error appears correctly
- **02:45** - [NORMAL] User navigates to edit mode

## UI State Transitions
[List all mode changes and screen transitions]

**Example format:**
- View mode → Edit mode (at 0:30)
- Form submission → Loading state → Success (at 1:15-1:20)
- Modal open → Data populated → Modal close (at 2:00-2:10)

## Errors & Validation
[List any errors, warnings, or validation messages]

**Categories:**
- User-visible errors (displayed in UI)
- DevTools errors (visible in Network/Console tab if open)
- Validation warnings
- Silent failures (no user feedback)

## Dropdown Selections & Data Entry
[List all dropdown selections, noting their FINAL values after all changes]

**Example format:**
- Insurance Type dropdown: Started as "Select an option", final value "Commercial Insurance"
- Status dropdown: Changed multiple times, final value persisted: "Active"

## GraphQL Activity
[If DevTools Network tab is visible, list GraphQL mutations/queries]

## Observations & Recommendations
[Note potential bugs, UX concerns, or areas needing deeper investigation]

**For frame extraction:**
- Suggest specific time ranges that need detailed frame-by-frame verification
- Note moments where state changes happen rapidly

---

**Important Analysis Rules:**

1. **Observable Evidence Only:** Quote exact UI text you see. Don't speculate about code or backend logic.

2. **Timestamp Everything:** Use MM:SS format. Be specific about when things happen.

3. **Distinguish User Actions from Bugs:**
   - Multiple dropdown selections = user testing (not auto-triggering)
   - Dropdown must be CLOSED to see final selected value
   - Look at VIEW mode to see what actually persisted

4. **Error Severity:**
   - CRITICAL: Backend error exists but no UI feedback (silent failure)
   - HIGH: Breaks core functionality, data loss risk
   - NORMAL: Works correctly but UX could improve

5. **Don't Assume Bugs:** If validation appears, it might be working correctly. Note it for verification against Jira requirements.

6. **UI Elements to Note:**
   - Button states (enabled/disabled)
   - Loading indicators
   - Success/error toasts
   - Modal dialogs
   - Empty states vs populated states
`;

    if (options.ticketId) {
      return `${basePrompt}

**Context:** This video is testing Jira ticket ${options.ticketId}.

Additional focus:
- Look for behavior that matches or violates expected functionality
- Note which acceptance criteria are being tested
- Identify coverage: what scenarios are verified vs remaining
`;
    }

    return basePrompt;
  }

  private parseAnalysis(rawText: string): VideoAnalysisResult {
    const sections = {
      summary: this.extractSection(rawText, 'Executive Summary'),
      criticalMoments: this.extractCriticalMoments(rawText),
      uiStateTransitions: this.extractList(rawText, 'UI State Transitions'),
      errorsFound: this.extractList(rawText, 'Errors & Validation'),
      graphqlActivity: this.extractList(rawText, 'GraphQL Activity'),
      dropdownSelections: this.extractList(rawText, 'Dropdown Selections & Data Entry'),
      recommendations: this.extractList(rawText, 'Observations & Recommendations')
    };

    return {
      ...sections,
      rawAnalysis: rawText
    };
  }

  private extractSection(text: string, sectionName: string): string {
    const regex = new RegExp(`##\\s*${sectionName}\\s*\\n([^]*?)(?=\\n##|$)`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  }

  private extractCriticalMoments(text: string): CriticalMoment[] {
    const section = this.extractSection(text, 'Critical Moments');
    const moments: CriticalMoment[] = [];

    // Match lines like: - **00:15** - [CRITICAL] Description
    const regex = /-\s*\*\*(\d+:\d+)\*\*\s*-\s*\[(\w+)\]\s*(.+)/gi;
    let match;

    while ((match = regex.exec(section)) !== null) {
      moments.push({
        timestamp: match[1],
        severity: match[2].toLowerCase() as 'critical' | 'high' | 'normal',
        description: match[3].trim()
      });
    }

    return moments;
  }

  private extractList(text: string, sectionName: string): string[] {
    const section = this.extractSection(text, sectionName);
    const lines = section.split('\n').filter(line => line.trim().startsWith('-'));
    return lines.map(line => line.replace(/^-\s*/, '').trim());
  }

  generateMarkdown(result: VideoAnalysisResult, options: CliOptions): string {
    const date = new Date().toISOString().split('T')[0];
    const videoStem = basename(options.videoPath, extname(options.videoPath));
    const videoFilename = basename(options.videoPath);
    const stats = existsSync(options.videoPath) ? statSync(options.videoPath) : null;

    const criticalCount = result.criticalMoments.filter(m => m.severity === 'critical').length;
    const highCount = result.criticalMoments.filter(m => m.severity === 'high').length;

    return `# AI Video Analysis - ${videoStem}

**Date**: ${date}
**Video**: ${videoFilename}
${options.ticketId ? `**Ticket**: ${options.ticketId}` : ''}
**Analysis Mode**: ${options.detailLevel}${options.useFrames ? ' (frame-based)' : ' (video-based)'}
**Model**: Gemini 2.5 Flash (Stable)
${options.useFrames ? `**FPS**: ${options.fps || 1} frame(s) per second` : ''}
${stats ? `**Video Size**: ${(stats.size / (1024 * 1024)).toFixed(2)} MB` : ''}

---

## AI-Generated Analysis

${result.rawAnalysis}

---

## Analysis Summary

**Critical Moments Found:** ${result.criticalMoments.length}
- CRITICAL severity: ${criticalCount}
- HIGH severity: ${highCount}
- NORMAL: ${result.criticalMoments.length - criticalCount - highCount}

**UI Transitions:** ${result.uiStateTransitions.length}
**Errors Detected:** ${result.errorsFound.length}
**GraphQL Activity:** ${result.graphqlActivity.length}

---

## Next Steps

### Immediate Actions
${criticalCount > 0 ? `
[!]  **${criticalCount} CRITICAL issue(s) found** - requires immediate verification
${result.criticalMoments.filter(m => m.severity === 'critical').map(m => `- ${m.timestamp}: ${m.description}`).join('\n')}
` : '[ok] No critical issues detected by AI'}

### Recommended Verification
1. **Review AI findings** - Read full analysis above
2. **Cross-reference with Jira** - Verify observed behavior against acceptance criteria
3. **Extract frames for evidence**:
   ${result.recommendations.length > 0 ? result.recommendations.filter(r => r.includes('frame') || r.includes('time')).map(r => `   - ${r}`).join('\n') : '   - Use full video frame extraction if detailed verification needed'}

### Frame Extraction Commands

\`\`\`bash
# Extract all frames (1 per second) - use for comprehensive verification
ffmpeg -i "${options.videoPath}" -vf "fps=1,scale=1200:-1" frames/frame_%04d.png -y

# Extract specific range (example: 10-30 seconds)
ffmpeg -i "${options.videoPath}" -ss 00:00:10 -to 00:00:30 -vf "fps=1,scale=1200:-1" frames/critical_frame_%04d.png -y
\`\`\`

---

## Cost Information

${result.usage ? `
**Actual Token Usage:**
- Input tokens: ${result.usage.inputTokens.toLocaleString()}
- Output tokens: ${result.usage.outputTokens.toLocaleString()}
- Total tokens: ${result.usage.totalTokens.toLocaleString()}

**Actual Cost:** $${result.usage.estimatedCost.toFixed(4)}

**Pricing (Gemini 2.5 Flash):**
- Input: $0.075 per 1M tokens
- Output: $0.30 per 1M tokens
` : `
**Estimated cost:** ~$0.02-0.04 (usage data not available)
`}
**Free Tier Limits:**
- Input: First 2M tokens/day free
- Output: First 32K tokens/day free
- Check remaining: https://aistudio.google.com/app/apikey

---

**Generated by:** Gemini API Video Analyzer v1.0
**Tool:** scripts/gemini-video-analyze.ts
**Timestamp:** ${new Date().toISOString()}
`;
  }
}

// CLI Implementation

function printUsage(): void {
  console.log(`
Gemini Video Analyzer

USAGE:
  npx tsx scripts/gemini-video-analyze.ts <video-path> [options]

OPTIONS:
  --ticket <ID>         Jira ticket ID to include in the analysis (e.g., PROJ-123)
  --detail <level>      Analysis detail: quick | detailed | exhaustive (default: detailed)
  --output <dir>        Output directory (default: same directory as video)
  --fps <number>        Frames per second to extract (default: 1, max: 10)
  --use-frames          Frame extraction mode (default)
  --no-frames           Video upload mode. Faster, but hallucinates UI text.
  --video-mode          Alias for --no-frames
  --help, -h            Show this help message

EXAMPLES:
  # Frame mode (default)
  npx tsx scripts/gemini-video-analyze.ts video.mov --ticket PROJ-123

  # Higher fps for fast-moving UI or lots of state changes
  npx tsx scripts/gemini-video-analyze.ts video.mov --fps 2 --detail exhaustive

  # Fast video mode (good for a quick look, not for filing evidence)
  npx tsx scripts/gemini-video-analyze.ts video.mov --video-mode --ticket PROJ-123

ENVIRONMENT:
  GEMINI_API_KEY        Required. Get from https://aistudio.google.com/apikey
                        Add to .env or export as an environment variable

COST:
  Frame mode (default): ~$0.05-0.10 per 60-90 second video
  Video mode:           ~$0.02-0.04 per 60-90 second video (faster, less accurate)
  Free tier:            1,500 requests/day, 1M tokens/minute

MODES:
  Frame (default):      Extracts frames and reads UI text directly. Accurate.
                        Use this for QA evidence or anything with form data.
  Video (--no-frames):  Uploads the whole video. Fast but hallucinates text.
                        Fine for a quick preview, not for filing a bug.

MODELS:
  gemini-2.5-flash      Fast and accurate. Free tier covers most recordings.
                        1M token context, released June 2025.
`);
}

function parseCli(args: string[]): CliOptions {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const options: Partial<CliOptions> = {
    detailLevel: 'detailed',
    fps: 1,
    useFrames: true  // Default to frame mode for accuracy
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg.startsWith('--')) {
      if (options.videoPath) {
        throw new Error(`Multiple video paths provided. Only one video at a time.\nGot: "${options.videoPath}" and "${arg}"`);
      }
      options.videoPath = arg;
      continue;
    }

    switch (arg) {
      case '--ticket':
        options.ticketId = readStringArg(args, ++i, arg);
        break;
      case '--detail': {
        const level = readStringArg(args, ++i, arg);
        if (!['quick', 'detailed', 'exhaustive'].includes(level)) {
          throw new Error(`Invalid detail level "${level}". Must be: quick, detailed, or exhaustive`);
        }
        options.detailLevel = level as 'quick' | 'detailed' | 'exhaustive';
        break;
      }
      case '--output':
        options.outputDir = readStringArg(args, ++i, arg);
        break;
      case '--use-frames':
        options.useFrames = true;
        break;
      case '--no-frames':
      case '--video-mode':
        options.useFrames = false;
        break;
      case '--fps': {
        const fps = parseFloat(readStringArg(args, ++i, arg));
        if (isNaN(fps) || fps <= 0 || fps > 10) {
          throw new Error(`Invalid FPS "${fps}". Must be a number greater than 0 and at most 10`);
        }
        options.fps = fps;
        break;
      }
      default:
        throw new Error(`Unknown option "${arg}". Use --help for usage.`);
    }
  }

  if (!options.videoPath) {
    throw new Error('No video file specified. Use --help for usage.');
  }

  return options as CliOptions;
}

function readStringArg(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Option "${flag}" requires a value`);
  }
  return value;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));

    // Resolve and validate video path
    const videoPath = resolve(options.videoPath);

    if (!existsSync(videoPath)) {
      console.error(`[error] Video file not found: ${videoPath}`);
      process.exit(1);
    }

    options.videoPath = videoPath;

    // Determine output directory
    const outputDir = options.outputDir
      ? resolve(options.outputDir)
      : dirname(videoPath);

    if (!existsSync(outputDir)) {
      console.error(`[error] Output directory not found: ${outputDir}`);
      console.error(`   Create it first or use existing directory`);
      process.exit(1);
    }

    // Initialize analyzer
    const analyzer = new GeminiVideoAnalyzer();

    // Run analysis
    const result = await analyzer.analyzeVideo(options);

    // Generate markdown
    const markdown = analyzer.generateMarkdown(result, options);

    // Write output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + Date.now();
    const outputFilename = `ai-analysis-${basename(videoPath, extname(videoPath))}-${timestamp}.md`;
    const outputPath = join(outputDir, outputFilename);

    writeFileSync(outputPath, markdown, 'utf-8');

    console.log(`\n[done] Analysis complete`);
    console.log(`[output] ${outputPath}`);
    console.log(`[summary]`);
    console.log(`   Critical moments: ${result.criticalMoments.length}`);
    console.log(`   UI transitions: ${result.uiStateTransitions.length}`);
    console.log(`   Errors detected: ${result.errorsFound.length}`);

    if (result.usage) {
      console.log(`\n[cost] Token Usage:`);
      console.log(`   Input tokens: ${result.usage.inputTokens.toLocaleString()}`);
      console.log(`   Output tokens: ${result.usage.outputTokens.toLocaleString()}`);
      console.log(`   Total tokens: ${result.usage.totalTokens.toLocaleString()}`);
      console.log(`   Estimated cost: $${result.usage.estimatedCost.toFixed(4)}`);
    }

    console.log(`\n[next] Check the report and pull frames where you need a closer look`);

  } catch (error) {
    console.error(`[error] ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run if this is the main module (ES module compatible check)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { GeminiVideoAnalyzer, VideoAnalysisResult, CliOptions };
