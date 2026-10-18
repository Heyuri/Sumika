#!/usr/bin/env python3

import argparse
import json
import random
from pathlib import Path

def entity_substrings(entity: str) -> list[str]:
    return [entity[:i] for i in range(1, len(entity) + 1)]

def load_entities(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise SystemExit("entities.json must contain a JSON object")

    entities = [
        key for key in data.keys()
        if isinstance(key, str) and key.startswith("&") and len(key) > 1
    ]

    if not entities:
        raise SystemExit("No valid entity names found in JSON file")

    return entities

def build_html(body_text: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Generated Entity Substrings</title>
</head>
<body>{body_text}</body>
</html>
"""

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Generate an HTML document filled with random substrings "
            "of entities loaded from entities.json."
        )
    )
    parser.add_argument(
        "count",
        type=int,
        help="Number of entity substrings to generate."
    )
    parser.add_argument(
        "-e",
        "--entities",
        type=Path,
        default=Path(__file__).parent / "../doc/entities.json",
        help="Path to entities.json."
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default="/tmp/entities.html",
        help="Output HTML filename. Default: /tmp/entities.html"
    )

    args = parser.parse_args()

    if args.count < 0:
        raise SystemExit("count must be non-negative")

    rng = random.Random(None)
    entities = load_entities(args.entities)

    pieces = []
    for _ in range(args.count):
        entity = rng.choice(entities)
        end = rng.randint(1, len(entity))
        pieces.append(entity[:end])

    body = "".join(pieces)
    document = build_html(body)

    output_path = Path(args.output)
    output_path.write_text(document, encoding="utf-8")

    print(f"Loaded {len(entities)} entities from {args.entities}")
    print(f"Wrote {args.count} raw entity substrings to {output_path}")

if __name__ == "__main__":
    main()
