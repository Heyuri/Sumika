## Bumping version

1. Change version numbers in `meson.build`, `configure.ac`,`setup.py` and `Doxyfile` files
2. Update `gumbo_version_info` in `configure.ac` according to [this](https://www.gnu.org/software/libtool/manual/html_node/Manual-version-info-update.html)
3. Update `version` argument in the `library` call with the same value in `meson.build`
4. Add changes log to `CHANGES.md` file

## Adding support for an HTML tag

1. Install [gpref](https://www.gnu.org/software/gperf)
2. Add tag name to `src/tag.in` file
3. Run `./gentags.sh`
4. Increment tags count in `GumboTagEnumTest` test in `tests/tokenizer.cc` file
