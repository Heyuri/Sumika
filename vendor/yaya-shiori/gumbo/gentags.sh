#!/bin/sh

set -e

cd "$(dirname "$0")"

data_file='src/tag.in'
perf_file='src/tag_gperf.h'

strs_file='src/tag_strings.h'
enum_file='src/tag_enum.h'
size_file='src/tag_sizes.h'

comment="Do not edit! Modify $data_file instead. Generated via gentags.sh"

echo "// $comment" > "$strs_file"
echo "// $comment" > "$enum_file"
echo "// $comment" > "$size_file"

while read -r tag; do
	tag_upper="$(echo "$tag" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"

	printf '"%s",\n'         "$tag"       >> "$strs_file"
	printf 'GUMBO_TAG_%s,\n' "$tag_upper" >> "$enum_file"
	printf '%d, '            "${#tag}"    >> "$size_file"
done < "$data_file"

gperf -LANSI-C --ignore-case -m200 --hash-function-name=tag_hash "$data_file" > "$perf_file"

hash_function="$(awk '/^static unsigned int/,/^}/' "$perf_file")"
wordlist_list="$(awk '/wordlist\[\]/,/};/' "$perf_file")"

# extract everything in between of { and }
map="$(echo "$wordlist_list" | awk '/{/,/}/')"

# delete whitespace, double quotes, curly brackets and semicolons
map="$(echo "$map" | tr -d '[:space:]' | tr -d '"{};')"

map="$(echo "$map" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
map="$(echo "$map" | sed 's/,/, /g' | tr ' ' '\n')"
map="$(echo "$map" | sed 's/^,$/LAST,/')"
map="$(echo "$map" | sed 's/^/ GUMBO_TAG_/' | tr ' ' '\t')"

echo "// $comment"                                    > "$perf_file"
echo "$hash_function"                                >> "$perf_file"
echo                                                 >> "$perf_file"
echo "static const unsigned char kGumboTagMap[] = {" >> "$perf_file"
echo "$map"                                          >> "$perf_file"
echo "};"                                            >> "$perf_file"
