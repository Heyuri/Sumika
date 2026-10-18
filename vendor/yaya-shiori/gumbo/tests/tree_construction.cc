// Copyright 2026 gumbo-parser contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#include "gtest/gtest.h"
#include "test_utils.h"

namespace {

struct DatCase {
  std::string file;
  int index = 0;
  int line = 0;
  bool script_on = false;
  std::string fragment_context;
  std::string input;
  std::string expected;
};

bool LoadDatFile(const std::filesystem::path& path,
                 std::vector<DatCase>* cases) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::string content((std::istreambuf_iterator<char>(in)),
                      std::istreambuf_iterator<char>());

  enum class Section { kNone, kData, kDocument, kFragment, kOther };
  Section section = Section::kNone;
  bool in_case = false;
  DatCase current;
  const std::string filename = path.filename().string();

  auto flush = [&]() {
    if (!in_case) return;
    in_case = false;
    if (!current.input.empty()) {
      current.input.pop_back();
    }
    while (!current.expected.empty() && current.expected.back() == '\n') {
      current.expected.pop_back();
    }
    if (!current.expected.empty()) {
      current.expected.push_back('\n');
    }
    cases->push_back(std::move(current));
  };

  int case_index = 0;
  int line_number = 0;
  for (size_t pos = 0; pos < content.size();) {
    size_t newline = content.find('\n', pos);
    if (newline == std::string::npos) newline = content.size();
    const std::string line = content.substr(pos, newline - pos);
    pos = newline + 1;
    ++line_number;

    if (line == "#data") {
      flush();
      in_case = true;
      current = DatCase();
      current.file = filename;
      current.index = ++case_index;
      current.line = line_number;
      section = Section::kData;
    } else if (line == "#document") {
      section = Section::kDocument;
    } else if (line == "#document-fragment") {
      section = Section::kFragment;
    } else if (line == "#script-on") {
      section = Section::kOther;
      current.script_on = true;
    } else if (line == "#errors" || line == "#new-errors" ||
               line == "#script-off") {
      section = Section::kOther;
    } else if (section == Section::kData) {
      current.input += line;
      current.input.push_back('\n');
    } else if (section == Section::kDocument) {
      current.expected += line;
      current.expected.push_back('\n');
    } else if (section == Section::kFragment) {
      current.fragment_context = line;
      section = Section::kOther;
    }
  }
  flush();
  return true;
}

class GumboTreeConstructionTest : public ::testing::Test {
 protected:
  GumboTreeConstructionTest() : options_(kGumboDefaultOptions) {
    InitLeakDetection(&options_, &malloc_stats_);
  }

  ~GumboTreeConstructionTest() override {
    if (output_) {
      gumbo_destroy_output(&options_, output_);
    }
    EXPECT_EQ(malloc_stats_.objects_allocated, malloc_stats_.objects_freed);
  }

  void Parse(const std::string& input, GumboTag context = GUMBO_TAG_LAST,
             GumboNamespaceEnum context_ns = GUMBO_NAMESPACE_HTML) {
    if (output_) {
      gumbo_destroy_output(&options_, output_);
    }
    options_.fragment_context = context;
    options_.fragment_namespace = context_ns;
    output_ = gumbo_parse_with_options(&options_, input.data(), input.length());
  }

  std::string Indent(int depth) {
    return "| " + std::string(2 * static_cast<size_t>(depth), ' ');
  }

  std::string ElementName(const GumboElement& element) {
    std::string name;
    if (element.tag != GUMBO_TAG_UNKNOWN) {
      name = gumbo_normalized_tagname(element.tag);
    } else {
      GumboStringPiece tag = element.original_tag;
      gumbo_tag_from_original_text(&tag);
      name.assign(tag.data, tag.length);
      for (char& c : name) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      }
    }
    if (element.tag_namespace == GUMBO_NAMESPACE_SVG) {
      GumboStringPiece piece = {name.c_str(), name.length()};
      const char* fixed = gumbo_normalize_svg_tagname(&piece);
      if (fixed) name = fixed;
    }
    return name;
  }

  std::string NamespacePrefix(GumboNamespaceEnum tag_namespace) {
    switch (tag_namespace) {
      case GUMBO_NAMESPACE_SVG:    return "svg ";
      case GUMBO_NAMESPACE_MATHML: return "math ";
      default:                     return "";
    }
  }

  std::string AttributePrefix(GumboAttributeNamespaceEnum attr_namespace) {
    switch (attr_namespace) {
      case GUMBO_ATTR_NAMESPACE_XLINK: return "xlink ";
      case GUMBO_ATTR_NAMESPACE_XML:   return "xml ";
      case GUMBO_ATTR_NAMESPACE_XMLNS: return "xmlns ";
      default:                         return "";
    }
  }

  std::string SerializeElement(GumboNode* node, int depth) {
    const GumboElement& element = node->v.element;
    std::string out = Indent(depth) + "<" +
                      NamespacePrefix(element.tag_namespace) +
                      ElementName(element) + ">\n";

    std::vector<std::string> attributes;
    for (int i = 0; i < GetAttributeCount(node); ++i) {
      const GumboAttribute* attribute = GetAttribute(node, i);
      attributes.push_back(AttributePrefix(attribute->attr_namespace) +
                           attribute->name + "=\"" + attribute->value + "\"");
    }
    std::sort(attributes.begin(), attributes.end());
    for (const std::string& attribute : attributes) {
      out += Indent(depth + 1) + attribute + "\n";
    }

    int child_depth = depth + 1;
    if (node->type == GUMBO_NODE_TEMPLATE &&
        element.tag_namespace == GUMBO_NAMESPACE_HTML) {
      out += Indent(depth + 1) + "content\n";
      child_depth = depth + 2;
    }
    for (int i = 0; i < GetChildCount(node); ++i) {
      out += SerializeNode(GetChild(node, i), child_depth);
    }
    return out;
  }

  std::string SerializeNode(GumboNode* node, int depth) {
    switch (node->type) {
      case GUMBO_NODE_ELEMENT:
      case GUMBO_NODE_TEMPLATE:
        return SerializeElement(node, depth);
      case GUMBO_NODE_TEXT:
      case GUMBO_NODE_WHITESPACE:
      case GUMBO_NODE_CDATA:
        return Indent(depth) + "\"" + node->v.text.text + "\"\n";
      case GUMBO_NODE_COMMENT:
        return Indent(depth) + "<!-- " + node->v.text.text + " -->\n";
      case GUMBO_NODE_PROCESSING_INSTRUCTION:
        return Indent(depth) + "<?" + node->v.text.text + "?>\n";
      case GUMBO_NODE_DOCUMENT:
        break;
    }
    return "";
  }

  std::string SerializeChildren(GumboNode* node, int depth) {
    std::string out;
    for (int i = 0; i < GetChildCount(node); ++i) {
      out += SerializeNode(GetChild(node, i), depth);
    }
    return out;
  }

  std::string SerializeDocument(GumboNode* document) {
    const GumboDocument& doc = document->v.document;
    std::string out;
    if (doc.has_doctype) {
      out += "| <!DOCTYPE ";
      out += doc.name;
      if (*doc.public_identifier || *doc.system_identifier) {
        out += " \"";
        out += doc.public_identifier;
        out += "\" \"";
        out += doc.system_identifier;
        out += "\"";
      }
      out += ">\n";
    }
    return out + SerializeChildren(document, 0);
  }

  bool Check(const DatCase& c) {
    GumboTag context_tag = GUMBO_TAG_LAST;
    GumboNamespaceEnum context_ns = GUMBO_NAMESPACE_HTML;
    if (!c.fragment_context.empty()) {
      std::string name = c.fragment_context;
      size_t space = name.find(' ');
      if (space != std::string::npos) {
        context_ns = name.compare(0, space, "svg") == 0
                         ? GUMBO_NAMESPACE_SVG
                         : GUMBO_NAMESPACE_MATHML;
        name = name.substr(space + 1);
      }
      context_tag = gumbo_tag_enum(name.c_str());
    }

    Parse(c.input, context_tag, context_ns);
    std::string actual = c.fragment_context.empty()
                             ? SerializeDocument(output_->document)
                             : SerializeChildren(output_->root, 0);
    if (actual == c.expected) {
      return true;
    }

    std::cout << std::endl
              << c.file << " case " << c.index
              << " (#data at line " << c.line << ")" << std::endl;
    if (!c.fragment_context.empty()) {
      std::cout << "CONTEXT: " << c.fragment_context << std::endl;
    }
    std::cout << "INPUT: " << c.input << std::endl
              << std::endl
              << "OUTPUT:" << std::endl
              << actual << std::endl
              << "EXPECTED:" << std::endl
              << c.expected << std::endl;
    return false;
  }

  MallocStats malloc_stats_;
  GumboOptions options_;
  GumboOutput* output_ = nullptr;
};

TEST_F(GumboTreeConstructionTest, TreeConstruction) {
  const std::filesystem::path samples_dir("tests/tree_construction");
  if (!std::filesystem::is_directory(samples_dir)) {
    GTEST_SKIP() << "Couldn't find tree construction references in "
                 << samples_dir;
  }

  std::vector<std::filesystem::path> files;
  for (const auto& entry : std::filesystem::directory_iterator(samples_dir)) {
    if (entry.path().extension() == ".dat") {
      files.push_back(entry.path());
    }
  }
  std::sort(files.begin(), files.end());
  ASSERT_FALSE(files.empty()) << "Couldn't find any .dat files in "
                              << samples_dir;

  int ran = 0;
  int fragments = 0;
  int failed = 0;
  int script_on_skipped = 0;
  for (const std::filesystem::path& file : files) {
    std::vector<DatCase> cases;
    ASSERT_TRUE(LoadDatFile(file, &cases)) << "Failed to read " << file;
    for (const DatCase& c : cases) {
      if (c.script_on) {
        ++script_on_skipped;
        continue;
      }
      if (!c.fragment_context.empty()) {
        ++fragments;
      }
      if (!Check(c)) {
        ++failed;
      }
      ++ran;
    }
  }

  std::cout << std::endl
    << "Total tests count:      " << ran               << std::endl
    << "Fragment tests count:   " << fragments         << std::endl
    << "Failed tests count:     " << failed            << std::endl
    << "Files processed:        " << files.size()      << std::endl
    << "Scripted tests skipped: " << script_on_skipped << std::endl
    << std::endl;

  EXPECT_GT(ran, 0);
  EXPECT_EQ(failed, 0);
}

} // namespace
