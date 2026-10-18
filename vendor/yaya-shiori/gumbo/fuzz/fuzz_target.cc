#include <cstdint>
#include <gumbo.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *Data, size_t Size) {
	GumboOutput* output = gumbo_parse_with_options(&kGumboDefaultOptions, reinterpret_cast<const char *>(Data), Size);
	gumbo_destroy_output(&kGumboDefaultOptions, output);
	return 0;
}
