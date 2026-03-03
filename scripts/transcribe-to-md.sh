#!/bin/bash

# Transcribe video/audio files to markdown using WhisperX
# Usage: ./transcribe-to-md.sh <file1.mov> [file2.mov] [file3.mov] ...

if [ $# -eq 0 ]; then
    echo "Usage: $0 <file1> [file2] [file3] ..."
    exit 1
fi

for file in "$@"; do
    if [ ! -f "$file" ]; then
        echo "Error: File not found: $file"
        continue
    fi

    echo "Processing: $file"

    dir=$(dirname "$file")
    base=$(basename "$file" | sed 's/\.[^.]*$//')

    whisperx "$file" --model large-v2 --output_format txt --output_dir "$dir"

    if [ -f "$dir/$base.txt" ]; then
        mv "$dir/$base.txt" "$dir/$base.md"
        echo "Created: $dir/$base.md"
    else
        echo "Warning: Expected output file not found: $dir/$base.txt"
    fi
done

echo "Done!"
