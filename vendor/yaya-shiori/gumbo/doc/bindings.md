## Python bindings

To install the Python bindings, make sure that the C library is installed first,
and then `sudo python setup.py install` from the root of the distro. This
installs a 'gumbo' module; `pydoc gumbo` should tell you about it.

Recommended best-practice for Python usage is to use one of the adapters to an
existing API (personally, I prefer BeautifulSoup) and write your program in
terms of those. The raw CTypes bindings should be considered building blocks for
higher-level libraries and rarely referenced directly.

## Other language bindings and tools

Many other language bindings and tools are available in other repositories.
They are based on the [original GitHub repository], but migrating them to newer
versions from this repository should not be difficult since there has been no
significant compatibility discrepancy with the old Gumbo.

* C++: [gumbo-query] by lazytiger
* Ruby: [ruby-gumbo] by Nicolas Martyanoff
* Node.js: [node-gumbo-parser] by Karl Westin
* D: [gumbo-d] by Christopher Bertels
* Lua: [lua-gumbo] by Craig Barnes
* Objective-C:
  * [ObjectiveGumbo] by Programming Thomas
  * [OCGumbo] by TracyYih
* C#: [GumboBindings] by Vladimir Zotov
* Perl: [HTML::Gumbo] by Ruslan Zakirov
* Julia: [Gumbo.jl] by James Porter
* C/Libxml: [gumbo-libxml] by Jonathan Tang

[original GitHub repository]: https://github.com/google/gumbo-parser
[gumbo-query]: https://github.com/lazytiger/gumbo-query
[ruby-gumbo]: https://github.com/nevir/ruby-gumbo
[node-gumbo-parser]: https://github.com/karlwestin/node-gumbo-parser
[gumbo-d]: https://github.com/bakkdoor/gumbo-d
[lua-gumbo]: https://github.com/craigbarnes/lua-gumbo
[ObjectiveGumbo]: https://github.com/programmingthomas/ObjectiveGumbo
[OCGumbo]: https://github.com/tracy-e/OCGumbo
[GumboBindings]: https://github.com/rgripper/GumboBindings
[HTML::Gumbo]: https://metacpan.org/pod/HTML::Gumbo
[Gumbo.jl]: https://github.com/porterjamesj/Gumbo.jl
[gumbo-libxml]: https://github.com/nostrademons/gumbo-libxml
