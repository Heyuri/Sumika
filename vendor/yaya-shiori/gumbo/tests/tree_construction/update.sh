#!/bin/sh

set -e

if [ -z "$1" ]; then
	echo "usage: $0 <PATH TO WPT DIRECTORY>"
	echo "WPT DIRECTORY is usually cloned from https://github.com/web-platform-tests/wpt"
	exit 1
fi

src="$1"
dest="$(realpath "$(dirname "$0")")"

if [ ! -d "$src" ]; then
	echo "$src is not a directory"
	exit 1
fi

rm -rf "$dest"/*.dat

for file in "$src"/html/syntax/parsing/resources/*.dat; do
	cp -v "$file" "$dest"/.
done
