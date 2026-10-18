project(
	'gumbo-parser',
	'c',
	version: '0.14.1',
	default_options: ['c_std=c99', 'default_library=both'],
)

summary({
	'Description': 'HTML parser library implemented in C99',
	'License':    'Apache-2.0',
	'Maintainer': 'Grigory Kirillov <me@txgk.in>',
})

gumbo_src = files(
	'src/attribute.c',
	'src/char_ref.c',
	'src/char_ref_gperf.c',
	'src/error.c',
	'src/parser.c',
	'src/string_buffer.c',
	'src/string_piece.c',
	'src/tag.c',
	'src/tokenizer.c',
	'src/utf8.c',
	'src/util.c',
	'src/vector.c',
)

if get_option('fuzz')
	if not meson.get_compiler('c').get_id().startswith('clang')
		error('Fuzzing requires clang. Try export CC=clang CXX=clang++')
	endif

	fuzz_languages = ['c']
	if add_languages('cpp', native: false)
		fuzz_languages += 'cpp'
		if not meson.get_compiler('cpp').get_id().startswith('clang')
			error('Fuzzing requires clang. Try export CC=clang CXX=clang++')
		endif
	endif

	add_project_arguments(
		'-fsanitize=fuzzer-no-link,address,undefined',
		'-fno-sanitize-recover=all',
		'-fno-omit-frame-pointer',
		language: fuzz_languages,
	)
	add_project_link_arguments(
		'-fsanitize=address,undefined',
		language: fuzz_languages,
	)

	fuzz_library_overrides = ['b_lundef=false']
else
	fuzz_library_overrides = []
endif

libgumbo = library(
	'gumbo',
	gumbo_src,
	version: '4.0.1',
	install: true,
	override_options: fuzz_library_overrides
)

install_headers('src/gumbo.h', 'src/tag_enum.h')

pkg = import('pkgconfig')
pkg.generate(libgumbo, filebase: 'gumbo', name: 'Gumbo', description: 'HTML parser library implemented in C99')

if get_option('python')
	if get_option('default_library') == 'static'
		error('Python bindings require the shared library')
	endif

	python = import('python').find_installation('python3')

	python.install_sources(
		'python/gumbo/__init__.py',
		'python/gumbo/gumboc.py',
		'python/gumbo/html5lib_adapter.py',
		'python/gumbo/soup_adapter.py',
		subdir: 'gumbo',
	)
endif

if get_option('tests')
	add_languages('cpp', native: false)

	# TODO: Fallback in case gtest isn't installed
	gtest_main = dependency('gtest_main')

	gumbo_test_src = files(
		'tests/attribute.cc',
		'tests/char_ref.cc',
		'tests/parser.cc',
		'tests/string_buffer.cc',
		'tests/string_piece.cc',
		'tests/tag.cc',
		'tests/tree_construction.cc',
		'tests/tokenizer.cc',
		'tests/test_utils.cc',
		'tests/utf8.cc',
		'tests/vector.cc',
	)

	gumbo_test = executable(
		'gumbo_test',
		gumbo_test_src,
		cpp_args: ['-std=c++17'],
		link_with: [libgumbo],
		include_directories: ['src'],
		dependencies: [gtest_main],
		install: false
	)

	test('gumbo_test', gumbo_test, workdir: meson.current_source_dir())
endif

if get_option('examples')
	add_languages('cpp', native: false)

	example_src = files(
		'examples/clean_text.cc',
		'examples/find_links.cc',
		'examples/positions_of_class.cc',
		'examples/prettyprint.cc',
		'examples/serialize.cc',
		'examples/get_title.c',
	)

	foreach f : example_src
		example_name = f.full_path().split('/')[-1].split('.')[0]
		executable(example_name, f, link_with: [libgumbo], include_directories: ['src'], c_args: ['-D_XOPEN_SOURCE=700'], install: false)
	endforeach
endif

if get_option('fuzz')
	gumbo_fuzz = executable(
		'gumbo_fuzz',
		'fuzz/fuzz_target.cc',
		link_args: ['-fsanitize=fuzzer'],
		link_with: [libgumbo],
		include_directories: ['src'],
		install: false,
	)
endif
