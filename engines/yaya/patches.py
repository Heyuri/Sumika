"""Patches applied to the UTF-8 copy of YAYA's sources (vendor/yaya-shiori, Tc606-2) before compiling to WebAssembly.
Each entry is (file, old, new); `old` must occur exactly once (sources are LF-normalised, .cpp and .h decoded from
CP932). Y1-Y17 come from the port research (each compared with yaya.dll there), N1-N11 from the page integration;
reasons in docs/research/yaya-wasm.md. Every change is under __EMSCRIPTEN__ except Y4 (an upstream bug fix) and Y8/Y15
(no-ops where wchar_t is 2 bytes). JS_PATCHES (J1, at the end) change the linked yaya.js instead.
"""

PATCHES = [
# -------------------------------------------------------------- Y1. code page 932 exactly like Windows (not musl iconv)
# musl decodes 0x815F/0x8160/0x8161/0x817C to U+005C/U+301C/U+2016/U+2212, fails on NEC row 13, the IBM extensions and
# the user-defined area, and writes '*' for what it cannot encode (U+FF5E, U+FF0D, U+FF3C, U+2460...). The table is
# engines/common/gen_cp932.py's (shared with Satori, checked against dumps made on Windows): yaya.dll converts with
# flags 0 (ccct.cpp), so the encoder adds the best-fit entries Satori leaves out. CHARSET_DEFAULT ("OS default", unknown
# charset names) means CP932 here, as on Japanese Windows.
('ccct.cpp',
'#  include <iconv.h>',
'''#  include <iconv.h>
#  ifdef __EMSCRIPTEN__
#    include "cp932_table.h"
#  endif'''),
('ccct.cpp',
'char *Ccct::utf16be_to_mbcs(const yaya::char_t *pUcsStr, int charset)',
'''#if defined(POSIX) && defined(__EMSCRIPTEN__)
// sumika: CP932 like MultiByteToWideChar(932, 0) / WideCharToMultiByte(932, 0). An invalid pair (or a lead byte at the
// end) becomes U+30FB and takes both bytes, as on Windows; what cannot be encoded becomes '?', a surrogate pair "??".
static yaya::string_t	EmCp932Decode(const char *s, size_t n)
{
	yaya::string_t o;
	o.reserve(n);
	const unsigned char *p = reinterpret_cast<const unsigned char*>(s);
	const unsigned char *e = p + n;
	while ( p < e ) {
		const unsigned char c = *p++;
		if ( c < 0x80 ) { o += static_cast<yaya::char_t>(c); continue; }
		const int li = ( c >= 0x81 && c <= 0x9F ) ? c - 0x81 : ( c >= 0xE0 && c <= 0xFC ) ? c - 0xE0 + 31 : -1;
		if ( li < 0 ) {
			const unsigned short u = cp932_single_hi[c - 0x80];
			o += static_cast<yaya::char_t>(u ? u : 0x30FB);
			continue;
		}
		if ( p >= e ) { o += static_cast<yaya::char_t>(0x30FB); break; }
		const unsigned char t = *p++;
		const unsigned short u = ( t >= 0x40 && t <= 0xFC ) ? cp932_dbcs[li * 189 + (t - 0x40)] : 0;
		o += static_cast<yaya::char_t>(u ? u : 0x30FB);
	}
	return o;
}

static bool	EmCp932Find(const unsigned short *ucs, const unsigned short *mb, unsigned int n, unsigned long c,
	unsigned short &out)
{
	unsigned int lo = 0, hi = n;
	while ( lo < hi ) {
		const unsigned int mid = (lo + hi) / 2;
		if ( ucs[mid] < c ) { lo = mid + 1; } else { hi = mid; }
	}
	if ( lo < n && ucs[lo] == c ) {
		out = mb[lo];
		return true;
	}
	return false;
}

static std::string	EmCp932Encode(const yaya::char_t *w)
{
	std::string o;
	for ( ; *w ; ++w ) {
		const unsigned long c = static_cast<unsigned long>(*w);
		if ( c < 0x80 ) { o += static_cast<char>(c); continue; }
		unsigned short mb = 0;
		// the table of WC_NO_BEST_FIT_CHARS, then what flags 0 adds (best fit: e.g. U+00E9 -> 'e')
		if ( c <= 0xFFFF && ( EmCp932Find(cp932_enc_ucs, cp932_enc_mb, cp932_enc_count, c, mb) ||
				EmCp932Find(cp932_bf_ucs, cp932_bf_mb, cp932_bf_count, c, mb) ) ) {
			if ( mb > 0xFF ) { o += static_cast<char>(mb >> 8); }
			o += static_cast<char>(mb & 0xFF);
		}
		else {
			o += '?';
		}
	}
	return o;
}
#endif

char *Ccct::utf16be_to_mbcs(const yaya::char_t *pUcsStr, int charset)'''),
('ccct.cpp',
'iconv_t cd = OpenIconv(charset, true);',
'''#ifdef __EMSCRIPTEN__
	if ( charset == CHARSET_SJIS || charset == CHARSET_DEFAULT ) {
		return string_to_malloc(EmCp932Encode(pUcsStr));
	}
#endif
	iconv_t cd = OpenIconv(charset, true);'''),
('ccct.cpp',
'iconv_t cd = OpenIconv(charset, false);',
'''#ifdef __EMSCRIPTEN__
	if ( charset == CHARSET_SJIS || charset == CHARSET_DEFAULT ) {
		return wstring_to_malloc(EmCp932Decode(pAnsiStr, nLen));
	}
#endif
	iconv_t cd = OpenIconv(charset, false);'''),

# ---------------------------------------------------------------- N11. CHARSET_DEFAULT is code page 932 (Y1)
# XmlCharsetName(CHARSET_DEFAULT) (jsonxml.cpp) asks for the code page: 0 on POSIX gave "UTF-8" over the CP932 bytes
# Y1 writes; 932 gives "Shift_JIS", as Japanese Windows does. Its only POSIX caller; the others are WIN32-only.
('ccct.cpp',
'#else\n\t\treturn 0;\n#endif',
'''#elif defined(__EMSCRIPTEN__)
		return 932;	// sumika: CHARSET_DEFAULT converts as CP932 here (Y1)
#else
		return 0;
#endif'''),

# ---------------------------------------------------------------- Y2. request() frees its input, like Satori's
# (src/worker/engines/index.js: "req: malloc'd, freed by the engine"). POSIX YAYA frees it only on the error paths.
('basis.cpp',
'std::string istr(h, *len);',
'''std::string istr(h, *len);
#ifdef __EMSCRIPTEN__
	free(h);	// sumika: the request buffer is the engine's on every path
	h = NULL;
#endif'''),

# ---------------------------------------------------------------- N6. requests and responses are always UTF-8
# The worker talks UTF-8 both ways. A script's SETSETTING('charset.output','Shift_JIS') would otherwise make the engine
# read the request and write the reply in Shift_JIS, which the worker decodes as UTF-8. No corpus config sets another
# output charset (the default is UTF-8), so this is a safety net.
('basis.cpp',
'wchar_t *wistr = Ccct::MbcsToUcs2(istr, output_charset);',
'''#ifdef __EMSCRIPTEN__
	wchar_t *wistr = Ccct::MbcsToUcs2(istr, CHARSET_UTF8);	// sumika: UTF-8 whatever charset.output says
#else
	wchar_t *wistr = Ccct::MbcsToUcs2(istr, output_charset);
#endif'''),
('basis.cpp',
'char *mostr = Ccct::Ucs2ToMbcs(res, output_charset);',
'''#ifdef __EMSCRIPTEN__
	char *mostr = Ccct::Ucs2ToMbcs(res, CHARSET_UTF8);	// sumika: UTF-8 whatever charset.output says
#else
	char *mostr = Ccct::Ucs2ToMbcs(res, output_charset);
#endif'''),

# ---------------------------------------------------------------- Y3. module name from the runtime, no DLL scan
# POSIX SetPath() names the module "yaya", or the base name of a *.dll in the ghost folder that has a *.txt beside it
# and contains the bytes "yaya.dll". DLLs are not shipped to the browser, so <name>.txt (aya5.txt, ...) would be
# missed and the ghost would boot in shell mode. The runtime calls yaya_set_module_name() (Y5) before load().
('basis.cpp',
'modulename = L"yaya";',
'''#ifdef __EMSCRIPTEN__
	// sumika: set by yaya_set_module_name() (descript.txt's shiori line); the DLL itself is not in the browser
	if ( modulename.empty() ) {
		modulename = L"yaya";
	}
	load_path = base_path;
	return;
#endif
	modulename = L"yaya";'''),

# ---------------------------------------------------------------- Y4. hlogrcvWnd was left uninitialised on POSIX
# CLog::Start() treats a non-NULL hwnd as "checker tool attached" and drops the log file path (log.cpp, Start).
('basis.cpp',
'run         = 0;',
'''hlogrcvWnd  = NULL;	// sumika: also on POSIX (CLog::Start reads it)
	run         = 0;'''),

# ---------------------------------------------------------------- N5. shell mode is visible to yaya_load_status()
# No <module>.txt, or no dictionary in it: the built-in request{EVAL(_argv[0])} answers the raw request text without
# SHIORI framing. In Sumika that only comes from a wrong module name or a ghost without config, so the boot fails.
('basis.cpp',
'if (dics.empty() && modename == L"normal") {',
'''if (dics.empty() && modename == L"normal") {
#ifdef __EMSCRIPTEN__
		extern bool g_yaya_em_shell;	// sumika: aya5.cpp, read by yaya_load_status()
		g_yaya_em_shell = true;
#endif'''),

# ---------------------------------------------------------------- Y17. default message language from the browser
# yaya.dll takes it from GetUserDefaultLangID (Japanese on a Japanese PC). std::locale("").name() never names the
# language in this build, so every ghost logged in English; Emscripten fills LANG from navigator.languages[0].
('basis.cpp',
'std::string name = std::locale("").name();',
'''#ifdef __EMSCRIPTEN__
			const char *lang_env = getenv("LANG");	// sumika: "ja_JP.UTF-8" from navigator.languages
			std::string name = lang_env ? lang_env : "";
#else
			std::string name = std::locale("").name();
#endif'''),

# ---------------------------------------------------------------- N2. log lines go to JavaScript (Module.yayaLog)
# yaya.dll sends its log to a checker tool or a file; here every VM, normal or emergency, gets em_loghandler (N1), which
# hands each line to Module.yayaLog(text, mode) as UTF-8. Modes are messages.h's: 0 info, 1 fatal, 2 error, 3 warning,
# 4 note, 5 other, 6 end, 16/17/32 charset markers (empty text, not forwarded). With a handler set CLog::Start drops the
# `log` key's file path, so no log file grows in MEMFS; request/response logging is off (N10).
('aya5.cpp',
'static size_t id_now=0;',
'''static size_t id_now=0;

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(void, js_yaya_log, (const char* s, int mode), {
	var f = Module['yayaLog'];
	if (f) { try { f(UTF8ToString(s), mode); } catch (e) {} }
});

static void	em_loghandler(const yaya::char_t *str, int mode, int id)
{
	(void)id;
	if ( ! str || ! *str ) {
		return;
	}
	char *s = Ccct::Ucs2ToMbcs(str, CHARSET_UTF8);
	if ( s ) {
		js_yaya_log(s, mode);
		free(s);
	}
}

bool g_yaya_em_shell = false;	// sumika: the normal VM fell back to shell mode (N5, basis.cpp)
static bool g_yaya_em_resume = false;	// sumika: yaya_load_resume() is running (N3, N4)
#endif'''),

# ---------------------------------------------------------------- N3. a resume restores the saved variables again
# A page navigation restarts the worker, not the ghost. The dictionary's load counts a boot, sets the boot minute and
# resets the talk timer (emily4's yaya_shiori3.dic: ghostuptimes, ghostbootmin, SHIORI3FW.LastAITalkTime); restoring
# the save once more after it gives every saved variable its saved value back. Variables the save lacks keep load's.
# The save is read before load runs: load may write it itself (cyau_cyaka's OnSystemLoad.INIT calls SAVEVAR()), and
# the file would then give load's values back. The copy is written to /tmp (outside the ghost root, so never persisted)
# for the second RestoreVariable only, and removed right after it; no ghost code runs meanwhile. Without a save before
# load there is no second restore.
('aya5.cpp',
'class CAyaVMWrapper {',
'''#ifdef __EMSCRIPTEN__
#include <sys/stat.h>
#include <unistd.h>
#include "posix_utils.h"

// sumika N3: the save file as it was before load ran (<module>_variable.cfg and its encoded .ays), for the second
// RestoreVariable of a resume
class CEmSaveCopy {
private:
	std::string data[2];	// the plain file, the .ays
	bool have[2];
	yaya::string_t leaf;	// <module>_variable.cfg
	std::string tmp;	// the copy under /tmp while Restore() reads it

	static bool Read(const std::string &path, std::string &out) {
		FILE *fp = fopen(path.c_str(), "rb");
		if ( ! fp ) { return false; }
		char buf[4096];
		size_t n;
		while ( (n = fread(buf, 1, sizeof(buf), fp)) > 0 ) { out.append(buf, n); }
		fclose(fp);
		return true;
	}
	static bool Write(const std::string &path, const std::string &in) {
		FILE *fp = fopen(path.c_str(), "wb");
		if ( ! fp ) { return false; }
		const bool ok = fwrite(in.data(), 1, in.size(), fp) == in.size();
		return fclose(fp) == 0 && ok;
	}
	void Remove(void) {
		if ( ! tmp.empty() ) {
			unlink(tmp.c_str());
			unlink((tmp + ".ays").c_str());
			tmp.clear();
		}
	}

public:
	CEmSaveCopy(void) { have[0] = have[1] = false; }
	~CEmSaveCopy() { Remove(); }	// also when RestoreVariable throws

	void Take(const yaya::string_t &savefile) {
		const std::string path = posix_path(savefile);
		have[0] = Read(path, data[0]);
		have[1] = Read(path + ".ays", data[1]);
		leaf = savefile.substr(savefile.find_last_of(L"/\\\\") + 1);
	}
	bool Empty(void) const { return ! have[0] && ! have[1]; }

	// RestoreVariable(name) reads root + name (+ ".ays", as for the save), so the name climbs from the root to /tmp
	void Restore(CBasis &basis) {
		const std::string root = posix_path(basis.GetRootPath());
		yaya::string_t name;
		for ( size_t i = 1; i < root.size(); ++i ) {
			if ( root[i] == '/' ) { name += L"../"; }
		}
		name += L"tmp/sumika-resume-" + leaf;
		tmp = "/tmp/sumika-resume-" + posix_path(leaf);
		mkdir("/tmp", 0777);
		if ( ( have[0] && ! Write(tmp, data[0]) ) || ( have[1] && ! Write(tmp + ".ays", data[1]) ) ) {
			basis.RestoreVariable();	// no copy: the save file as load left it (the same unless load wrote it)
		}
		else {
			basis.RestoreVariable(name.c_str());
		}
		Remove();
	}
};
#endif

class CAyaVMWrapper {'''),
('aya5.cpp',
'\t\tvm->basis().ExecuteLoad();',
'''#ifdef __EMSCRIPTEN__
		const bool em_resume = g_yaya_em_resume && ! vm->basis().IsSuppress() && ! g_yaya_em_shell;
		CEmSaveCopy em_save;	// sumika N3: the save before load can rewrite it
		if ( em_resume ) {
			em_save.Take(vm->basis().GetSavefilePath());
		}
#endif
		vm->basis().ExecuteLoad();
#ifdef __EMSCRIPTEN__
		if ( em_resume && ! vm->basis().IsSuppress() && ! g_yaya_em_shell && ! em_save.Empty() ) {
			em_save.Restore(vm->basis());	// sumika N3: a page navigation is not a boot (yaya_load_resume)
		}
#endif'''),

# ---------------------------------------------------------------- Y5. exports for the runtime
('aya5.cpp',
'#include "misc.h"',
'''#include "misc.h"
#ifdef __EMSCRIPTEN__
#include "value.h"	// sumika: CValue for EmSave()
#endif'''),
('aya5.cpp',
'bool IsSuppress(void) {',
'''#ifdef __EMSCRIPTEN__
	// sumika: write the save file now (a page can go away without unload). 1 = written
	int EmSave(void) {
		if ( ! vm || vm->basis().IsSuppress() ) { return 0; }
		if ( vm->basis().GetParameter(L"save.auto").GetValueString() != L"on" ) { return 0; }
		vm->basis().SaveVariable();
		return 1;
	}
#endif
	bool IsSuppress(void) {'''),
# with N4: yaya_load_resume() and yaya_load_status()
('aya5.cpp',
'extern "C" DLLEXPORT BOOL_TYPE FUNCATTRIB unload()',
'''#ifdef __EMSCRIPTEN__
// sumika: the module's base name, e.g. "yaya" or "aya5" (descript.txt shiori line without .dll). It picks
// <name>.txt, <name>_emerg.txt and <name>_variable.cfg. Call before load(); the string is copied, the caller frees it.
extern "C" DLLEXPORT void yaya_set_module_name(const char *name, long len)
{
	Ccct::MbcsToUcs2Buf(modulename, std::string(name, static_cast<size_t>(len)), CHARSET_UTF8);
}

// sumika: SaveVariable() now, if the ghost's config has save.auto on (the default). 1 = written
extern "C" DLLEXPORT int yaya_save(void)
{
	return vm[0] ? vm[0]->EmSave() : 0;
}

// sumika N4: load() for a page navigation (resume): after the dictionary's load ran, the save as it was before load is
// restored once more (N3). Frees h like load(); 0 if loading threw.
extern "C" DLLEXPORT int yaya_load_resume(yaya::global_t h, long len)
{
	g_yaya_em_resume = true;
	int r = 0;
	try {
		r = load(h, len);
	}
	catch ( ... ) {
		free(h);	// load() frees it after the VM is built, so not yet
		r = 0;
	}
	g_yaya_em_resume = false;
	return r;
}

// sumika N4: how the last load went (load() returns 1 whatever happened; CI_check_failed() is suppressed OR emergency):
// -1 no VM, 0 normal, 1 emergency (<module>_emerg.txt answers), 2 suppressed (nothing usable), 3 shell mode (N5)
extern "C" DLLEXPORT int yaya_load_status(void)
{
	if ( ! vm[0] ) { return -1; }
	if ( vm[0]->IsSuppress() ) { return 2; }
	if ( vm[0]->IsEmergency() ) { return 1; }
	if ( g_yaya_em_shell ) { return 3; }
	return 0;
}
#endif

extern "C" DLLEXPORT BOOL_TYPE FUNCATTRIB unload()'''),

# ---------------------------------------------------------------- N1. load(): locale, a second load, the log handler
# Y14's setlocale: musl's wide printf writes through wcrtomb, which in the "C" locale (byte-based) fails on every
# non-ASCII character (STRFORM("$10s", "あいう") printed only the padding). yaya.dll calls setlocale(LC_ALL, "")
# (aya5.cpp AYA_InitModule); here LC_CTYPE becomes C.UTF-8 (only multibyte conversions; numbers stay "C").
('aya5.cpp',
'extern "C" DLLEXPORT BOOL_TYPE FUNCATTRIB load(yaya::global_t h, long len)\n{',
'''extern "C" DLLEXPORT BOOL_TYPE FUNCATTRIB load(yaya::global_t h, long len)
{
#ifdef __EMSCRIPTEN__
	setlocale(LC_CTYPE, "C.UTF-8");	// sumika: wide printf (STRFORM $s/$c) needs a UTF-8 LC_CTYPE
	if ( vm[0] ) {
		free(h);	// sumika: a second load keeps the VM, as upstream, but frees the path (upstream leaks it)
		return 1;
	}
	g_yaya_em_shell = false;
	enlarge_loghandler_list(1);
	loghandler_list[0] = em_loghandler;	// sumika N2: before the VMs are built, so the emergency VM logs too
#endif'''),

# ---------------------------------------------------------------- Y6. SAORI -> JavaScript bridge (Module.saoriBridge)
# Same JS interface as Satori's patch 2 (engines/satori/patches.py), so src/worker/saori serves both engines.
# SAORI-basic (executables, fork/execv) also goes to the stand-ins; dlopen/dlsym are never reached.
('lib.h',
'isBasic = IsBasicName(n);',
'''#ifdef __EMSCRIPTEN__
		isBasic = false;	// sumika: DLL or executable, every SAORI goes to the JavaScript stand-ins
#else
		isBasic = IsBasicName(n);
#endif'''),
('lib1.cpp',
'#include "globaldef.h"',
'''#include "globaldef.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <stdint.h>
// sumika: SAORI calls go to JavaScript stand-ins (Module.saoriBridge) instead of dlopen().
//   load(path, dir) -> handle > 0, or 0 when there is no stand-in
//   request(handle, Uint8Array request) -> string | Uint8Array (raw SAORI/1.0 response)
//   unload(handle)
EM_JS(int, js_saori_load, (const char* path, const char* dir), {
	var b = Module['saoriBridge'];
	if (!b) return 0;
	try { return b.load(UTF8ToString(path), UTF8ToString(dir)) | 0; } catch (e) { err('SAORI load: ' + e); return 0; }
});
EM_JS(char*, js_saori_request, (int h, const char* req, int len, int* out_len), {
	var b = Module['saoriBridge'], r = null;
	try { if (b) r = b.request(h, HEAPU8.slice(req, req + len)); } catch (e) { err('SAORI request: ' + e); }
	if (typeof r === 'string') r = new TextEncoder().encode(r);
	if (!r || !r.length) r = new TextEncoder().encode('SAORI/1.0 500 Internal Server Error\\r\\nCharset: UTF-8\\r\\n\\r\\n');
	var p = _malloc(r.length + 1);
	HEAPU8.set(r, p); HEAPU8[p + r.length] = 0;
	HEAP32[out_len >> 2] = r.length;
	return p;
});
EM_JS(void, js_saori_unload, (int h), {
	var b = Module['saoriBridge'];
	try { if (b) b.unload(h); } catch (e) { err('SAORI unload: ' + e); }
});
#endif'''),
('lib1.cpp',
'int CLib1::LoadLib() {',
'''int CLib1::LoadLib() {
#ifdef __EMSCRIPTEN__
	if ( hDLL != NULL ) {
		return 1;
	}
	{
		const std::string path = posix_path(name);
		const std::string dir = path.substr(0, path.rfind('/') + 1);
		const int h = js_saori_load(path.c_str(), dir.c_str());
		if ( h <= 0 ) {
			yaya::string_t wmessage;
			Ccct::MbcsToUcs2Buf(wmessage, path + ": no JavaScript stand-in for this SAORI\\n", CHARSET_UTF8);
			vm.logger().Write(wmessage);
			return 0;
		}
		hDLL = reinterpret_cast<module_t>(static_cast<intptr_t>(h));
		return 1;
	}
#endif'''),
('lib1.cpp',
'int CLib1::Load(void) {',
'''int CLib1::Load(void) {
#ifdef __EMSCRIPTEN__
	return LoadLib();	// sumika: the stand-in's load(path) ran in js_saori_load
#endif'''),
('lib1.cpp',
'int CLib1::Unload(void) {',
'''int CLib1::Unload(void) {
#ifdef __EMSCRIPTEN__
	if ( hDLL == NULL ) {
		return 2;
	}
	js_saori_unload(static_cast<int>(reinterpret_cast<intptr_t>(hDLL)));
	hDLL = NULL;
	return 1;
#endif'''),
('lib1.cpp',
'int CLib1::Request(const yaya::string_t &istr, yaya::string_t &ostr) {',
'''int CLib1::Request(const yaya::string_t &istr, yaya::string_t &ostr) {
#ifdef __EMSCRIPTEN__
	ostr.clear();
	if ( hDLL == NULL ) {
		return 0;
	}
	{
		// sumika: the stand-ins read UTF-8 (Shift_JIS fallback) and answer UTF-8, whatever CHARSETLIB says
		std::string req;
		char *t = Ccct::Ucs2ToMbcs(istr, CHARSET_UTF8);
		if ( t ) {
			req = t;
			free(t);
		}
		int out_len = 0;
		char *r = js_saori_request(static_cast<int>(reinterpret_cast<intptr_t>(hDLL)), req.data(), static_cast<int>(req.size()), &out_len);
		if ( r == NULL ) {
			return 1;
		}
		const std::string res(r, static_cast<size_t>(out_len));
		free(r);
		Ccct::MbcsToUcs2Buf(ostr, res, CHARSET_UTF8);
		return 1;
	}
#endif'''),

# ---------------------------------------------------------------- N10. no request/response log
# iolog is on by default, and with the handler set (N2) every request and response (two blocks per OnSecondChange) and
# every SAORI call would go to JavaScript. Only the errors, warnings and notes are wanted.
('log.cpp',
'void\tCLog::Io(char io, const yaya::char_t *str)\n{',
'''void	CLog::Io(char io, const yaya::char_t *str)
{
#ifdef __EMSCRIPTEN__
	if ( true ) { return; }	// sumika: no request/response log in the browser
#endif'''),
('log.cpp',
'void\tCLog::IoLib(char io, const yaya::string_t &str, const yaya::string_t &name)\n{',
'''void	CLog::IoLib(char io, const yaya::string_t &str, const yaya::string_t &name)
{
#ifdef __EMSCRIPTEN__
	if ( true ) { return; }	// sumika: no SAORI request/response log in the browser
#endif'''),

# ---------------------------------------------------------------- Y7. STRDIGEST hashes UTF-16LE bytes, as on Windows
# The code hashes the wchar_t array: 2 bytes per unit on Windows, 4 here, so every digest would differ.
('sysfunc.cpp',
'const size_t buf_len = buf.size() * sizeof(yaya::char_t);\n\tunsigned char* buf_ptr = (unsigned char*)buf.c_str();',
'''#ifdef __EMSCRIPTEN__
	// sumika: the bytes of Windows' 2-byte wchar_t (UTF-16LE), not the 4-byte wchar_t of this build
	std::string u16le;
	u16le.reserve(buf.size() * 2);
	for ( size_t i = 0; i < buf.size(); ++i ) {
		u16le += static_cast<char>(buf[i] & 0xFF);
		u16le += static_cast<char>((buf[i] >> 8) & 0xFF);
	}
	const size_t buf_len = u16le.size();
	unsigned char* buf_ptr = (unsigned char*)u16le.data();
#else
	const size_t buf_len = buf.size() * sizeof(yaya::char_t);
	unsigned char* buf_ptr = (unsigned char*)buf.c_str();
#endif'''),

# ---------------------------------------------------------------- Y8. YAML/TOML \\U escapes as surrogate pairs
# Elsewhere YAYA keeps UTF-16 units even in a 4-byte wchar_t (ccct.cpp); a lone code point > 0xFFFF would be cut to
# 16 bits by Ccct_ConvUnicodeToUTF8.
('yamltoml.cpp',
'if ( sizeof(yaya::char_t) == 2 && cp >= 0x10000 ) {',
'if ( cp >= 0x10000 ) {	// sumika: UTF-16 units in a 32-bit wchar_t too, like ccct.cpp'),

# ---------------------------------------------------------------- Y9. built-in message tables, like the DLL's resources
# yaya.dll reads messagetxt/<lang>.txt from its own resources first (aya5.rc, LoadMessageFromTxtResource), so the
# ghost's own messagetxt/ folder only matters for other names. messagetxt_builtin.h is generated by msgtables.py
# (--embed-file would need file_packager, whose .exe launcher fails in this emsdk).
('messages.cpp',
'#include "misc.h"',
'''#include "misc.h"
#ifdef __EMSCRIPTEN__
#include <strings.h>
#include "messagetxt_builtin.h"	// sumika: yaya_builtin_messagetxt[]
#endif'''),
('messages.cpp',
'LoadMessageFromTxtResource(basepath,filename,cset,lines);\n\n#endif',
'''LoadMessageFromTxtResource(basepath,filename,cset,lines);

#endif
#if defined(__EMSCRIPTEN__)
	// sumika: the same lookup as LoadMessageFromTxtResource, over the compiled-in tables
	{
		yaya::string_t name_w = filename;
		yaya::ws_replace(name_w,L"messagetxt",L"");
		yaya::ws_replace(name_w,L".txt",L"");
		yaya::ws_replace(name_w,L"\\\\",L"");
		yaya::ws_replace(name_w,L"/",L"");
		const std::string name_a = Ccct::Ucs2ToPlainASCII(name_w);
		for ( size_t i = 0; i < sizeof(yaya_builtin_messagetxt) / sizeof(yaya_builtin_messagetxt[0]); ++i ) {
			if ( strcasecmp(name_a.c_str(), yaya_builtin_messagetxt[i].name) != 0 ) {
				continue;
			}
			yaya::char_t *pc = Ccct::MbcsToUcs2(yaya_builtin_messagetxt[i].text, cset);
			if ( pc ) {
				yaya::char_t *pcs = pc;
				while ( true ) {
					yaya::char_t *pce = wcschr(pcs, L'\\n');
					if ( ! pce ) {
						lines.emplace_back(yaya::string_t(pcs));
						break;
					}
					*pce = 0;
					lines.emplace_back(yaya::string_t(pcs));
					pcs = pce + 1;
				}
				free(pc);
			}
			break;
		}
	}
#endif'''),

# ---------------------------------------------------------------- Y11. GETTICKCOUNT counts from the ghost's cold boot
('sysfunc.cpp',
'#define SYSFUNC_HIS_NAME L"EmBeD_HiStOrY"',
'''#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// sumika: GETTICKCOUNT counts from Module.bootEpochMs (the ghost's last cold boot), like Satori's P7 clock;
// -1 without it (then the worker's age). Date.now is read once, then performance.now: monotonic.
EM_JS(double, js_yaya_tick_ms, (), {
	var e = Module['bootEpochMs'];
	if (!(e > 0)) return -1;
	if (Module['emTickBaseMs'] === undefined) {
		Module['emTickBaseMs'] = Math.max(0, Date.now() - e);
		Module['emTickPerf0'] = performance.now();
	}
	return Math.floor(Module['emTickBaseMs'] + performance.now() - Module['emTickPerf0']);
});
#endif

#define SYSFUNC_HIS_NAME L"EmBeD_HiStOrY"'''),
('sysfunc.cpp',
'// GetTickCount64 と同じく、時刻の調整で戻らない「起動からの経過時間」を返す',
'''// GetTickCount64 と同じく、時刻の調整で戻らない「起動からの経過時間」を返す
#ifdef __EMSCRIPTEN__
	{
		const double ms = js_yaya_tick_ms();
		if ( ms >= 0 ) {
			return CValue(static_cast<yaya::int_t>(ms));
		}
	}
#endif'''),

# ---------------------------------------------------------------- N7. EXECUTE / EXECUTE_WAIT: nothing runs
# A browser runs no program. -1 is Windows' failure value (ShellExecute <= 32, or a failed CreateProcess).
('sysfunc.cpp',
'return CValue(ExecutePosix(MakeExecuteCommandPosix(file, param), s_dir, false));',
'''#ifdef __EMSCRIPTEN__
	(void)s_dir;
	return CValue(static_cast<yaya::int_t>(-1));	// sumika: nothing runs in a browser
#else
	return CValue(ExecutePosix(MakeExecuteCommandPosix(file, param), s_dir, false));
#endif'''),
('sysfunc.cpp',
'result = ExecutePosix(MakeExecuteCommandPosix(file, param), s_dir, true);',
'''#ifdef __EMSCRIPTEN__
	(void)s_dir;
	result = -1;	// sumika: nothing runs in a browser
#else
	result = ExecutePosix(MakeExecuteCommandPosix(file, param), s_dir, true);
#endif'''),

# ---------------------------------------------------------------- N8. GETENV: every name is unset
# Emscripten's environment (HOME=/home/web_user, USER, PATH ...) is not the visitor's. An unset name gives "" with
# warning 12 and GETLASTERROR 12, as on Windows. ENV.LANG stays inside for Y17 and the locale.
('sysfunc.cpp',
'const char *s_env = getenv(s_name);',
'''#ifdef __EMSCRIPTEN__
	const char *s_env = NULL;	// sumika: no environment in a browser
#else
	const char *s_env = getenv(s_name);
#endif'''),

# ---------------------------------------------------------------- Y13. SRAND(string) seeds like Windows
# The seed words are the wchar_t bytes: 4 UTF-16 units per 64-bit word on Windows, 2 (UTF-32) here.
('sysfunc.cpp',
'vm.genrand_sysfunc_srand_array(reinterpret_cast<const std::uint64_t*>(wstr.c_str()),wstr.size()/(targetByteAlignment/wcharSize));',
'''#ifdef __EMSCRIPTEN__
			{
				// sumika: Windows' words: 4 UTF-16 units each, little-endian, the string padded with '0' (as above)
				yaya::string_t s = p.arg.array()[0].GetValueString();
				if ( s.empty() ) { s = L"0"; }
				while ( s.size() % 4 ) { s += L'0'; }
				std::vector<std::uint64_t> words;
				for ( size_t i = 0; i < s.size(); i += 4 ) {
					std::uint64_t w = 0;
					for ( size_t j = 0; j < 4; ++j ) {
						w |= static_cast<std::uint64_t>(s[i + j] & 0xFFFF) << (16 * j);
					}
					words.push_back(w);
				}
				vm.genrand_sysfunc_srand_array(&words[0], static_cast<int>(words.size()));
			}
#else
			vm.genrand_sysfunc_srand_array(reinterpret_cast<const std::uint64_t*>(wstr.c_str()),wstr.size()/(targetByteAlignment/wcharSize));
#endif'''),

# ---------------------------------------------------------------- Y14. STRFORM $s / $c with a standard wide printf
# YAYA writes "%s" and "%llc" for vswprintf. MSVC reads %s as wchar_t* and prints %c as a wchar_t; a standard (musl)
# wide printf reads %s as char* (so "abc" prints "a", Japanese prints garbage) and rejects %llc (empty). The locale it
# needs is set in load() (N1).
('sysfunc.cpp',
'yaya::snprintf(t_str,t_str_size,t_format.c_str(),p.arg.array()[i].GetValueString().c_str());',
'''#ifdef __EMSCRIPTEN__
				{
					yaya::string_t f = t_format;
					f.insert(f.size() - 1, L"l");	// sumika: %ls is the wchar_t* string
					yaya::snprintf(t_str,t_str_size,f.c_str(),p.arg.array()[i].GetValueString().c_str());
				}
#else
				yaya::snprintf(t_str,t_str_size,t_format.c_str(),p.arg.array()[i].GetValueString().c_str());
#endif'''),
('sysfunc.cpp',
'yaya::snprintf(t_str,t_str_size,t_format.c_str(),p.arg.array()[i].GetValueInt());',
'''#ifdef __EMSCRIPTEN__
				if ( t_format[t_format.size() - 1] == L'c' || t_format[t_format.size() - 1] == L'C' ) {
					// sumika: "%llc" -> "%lc" with a wint_t: the UTF-16 unit, as MSVC prints it
					yaya::string_t f = t_format.substr(0, t_format.size() - 3) + L"lc";
					yaya::snprintf(t_str,t_str_size,f.c_str(),static_cast<wint_t>(p.arg.array()[i].GetValueInt() & 0xFFFF));
					break;
				}
#endif
				yaya::snprintf(t_str,t_str_size,t_format.c_str(),p.arg.array()[i].GetValueInt());'''),

# ---------------------------------------------------------------- Y15. CHR keeps 16 bits, as with Windows' wchar_t
# CHR(0x1F600): Windows stores 0xF600 (CHRCODE 62976); a 4-byte wchar_t kept 0x1F600 (CHRCODE 128512). The bytes
# sent out were already the same (Ccct_ConvUnicodeToUTF8 cuts to 16 bits).
('sysfunc.cpp',
'yaya::string_t r_value(1, static_cast<yaya::char_t>(p.arg.array()[0].GetValueInt()));',
'yaya::string_t r_value(1, static_cast<yaya::char_t>(p.arg.array()[0].GetValueInt() & 0xFFFF));	// sumika: 16-bit unit'),
('sysfunc.cpp',
'r_value.append(1, static_cast<yaya::char_t>(i->GetValueInt()) );',
'r_value.append(1, static_cast<yaya::char_t>(i->GetValueInt() & 0xFFFF) );	// sumika: 16-bit unit'),

# ---------------------------------------------------------------- Y16. SPLITPATH with the Windows rules
# POSIX SPLITPATH returns no drive, '/' separators and the extension without its dot ("txt"); ghosts are written for
# Windows ("C:", "\\dir\\", "file", ".txt"). The Windows version only uses the portable SplitPathParts (misc.cpp).
('sysfunc.cpp',
'#if defined(WIN32)\nCValue\tCSystemFunction::SPLITPATH(CSF_FUNCPARAM &p)',
'#if defined(WIN32) || defined(__EMSCRIPTEN__)\t// sumika: Windows rules\nCValue\tCSystemFunction::SPLITPATH(CSF_FUNCPARAM &p)'),

# ---------------------------------------------------------------- N9. GETMEMINFO: fixed values
# The browser hides the machine. An 8 GiB PC running a 32-bit process: physical total and available, the process's
# virtual total and available. GETMEMINFO computes the load from the first two in integers:
# (8589934592 - 4724464025) * 100 / 8589934592 = 45.
('posix_utils.cpp',
'void posix_get_meminfo(posix_meminfo& mi) {',
'''void posix_get_meminfo(posix_meminfo& mi) {
#ifdef __EMSCRIPTEN__
	mi.total_phys = 8589934592ULL;	// sumika: fixed values, see engines/yaya/patches.py N9
	mi.avail_phys = 4724464025ULL;
	mi.total_virtual = 2147352576ULL;
	mi.avail_virtual = 1717986918ULL;
	return;
#endif'''),
]

# Patches applied to the linked yaya.js (Emscripten's runtime, not YAYA's sources) by build.py before its post-check:
# (name, regular expression, replacement), each must match exactly once. Expressions, because the release JS is
# minified and the debug JS is not.
JS_PATCHES = [
# ---------------------------------------------------------------- J1. MEMFS removes a name in the case it was made in
# -sCASE_INSENSITIVE_FS finds a node in any case, but MEMFS's unlink and rmdir then delete parent.contents[name] in the
# caller's case: FDEL('var/NOTE.TXT') of var/Note.txt (Windows allows it) left 'Note.txt' listed with no node behind
# it, so FENUM skipped the folder's other files and the worker's scan of the ghost root threw ENOENT on every later
# report. A rename over a file of another case left the replaced one listed the same way. Each deletes the key of the
# node it removes (= its name).
('MEMFS unlink',
 r'(unlink\(parent,\s*name\)\s*\{\s*)delete parent\.contents\[name\];',
 r'\1delete parent.contents[FS.lookupNode(parent, name).name];'),
('MEMFS rmdir',
 r'(for\s*\(var i in node\.contents\)\s*\{\s*throw new FS\.ErrnoError\(55\);?\s*\}\s*)delete parent\.contents\[name\];',
 r'\1delete parent.contents[node.name];'),
('MEMFS rename',
 r'FS\.hashRemoveNode\(new_node\);?(\s*\})',
 r'FS.hashRemoveNode(new_node);delete new_dir.contents[new_node.name];\1'),
]
