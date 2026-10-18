"""Patches applied to the UTF-8 copy of Satori's sources before compiling to WebAssembly.
Each entry is (file, old, new); `old` must occur exactly once (sources are LF-normalised first).
P1-P4 come from docs/research/satori-wasm.md section 8 (verified there); P6 and P7 from docs/research/SUMMARY.md
section 2.1; P8 from satori-wasm.md section 8 (needs satori/SakuraFMO and satori/satoriFMO in build.py's SOURCES).
"""

PATCHES = [
# ---------------------------------------------------------------- 1. CP932 exactly like Windows (not musl iconv)
('_/charset.cpp',
'''#ifdef POSIX
#include	<iconv.h>
#include	<errno.h>
#else''',
'''#if defined(POSIX) && defined(__EMSCRIPTEN__)
#include	"cp932_table.h"
#elif defined(POSIX)
#include	<iconv.h>
#include	<errno.h>
#else'''),
('_/charset.cpp',
'''#ifdef POSIX

static std::string	iconv_convert(''',
'''#if defined(POSIX) && defined(__EMSCRIPTEN__)

// sumika: code page 932 as satori.dll converts it on Windows (mb2w/w2mb below: MultiByteToWideChar(932, 0) and
// WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS)), from the table engines/common/gen_cp932.py checks against dumps
// made on Windows. musl's iconv maps 0x8160/0x817C/0x815F to U+301C/U+2212/U+005C and has no NEC/IBM extensions.
static int	cp932_lead_index(unsigned char c)
{
	if ( c >= 0x81 && c <= 0x9F ) { return c - 0x81; }
	if ( c >= 0xE0 && c <= 0xFC ) { return c - 0xE0 + 31; }
	return -1;
}

std::wstring	SJIStoW(const std::string& str)
{
	std::wstring o;
	o.reserve(str.size());
	const unsigned char* p = reinterpret_cast<const unsigned char*>(str.data());
	const unsigned char* e = p + str.size();
	while ( p < e ) {
		const unsigned char c = *p++;
		if ( c < 0x80 ) { o += static_cast<wchar_t>(c); continue; }
		const int li = cp932_lead_index(c);
		if ( li < 0 ) {
			const unsigned short u = cp932_single_hi[c - 0x80];
			o += static_cast<wchar_t>(u ? u : 0x30FB);
			continue;
		}
		// a lead byte takes the next byte whatever it is (even a newline); an invalid pair is one U+30FB, and so is a
		// lead byte at the end (measured: engines/common/cp932/windec.txt)
		if ( p >= e ) { o += static_cast<wchar_t>(0x30FB); break; }
		const unsigned char t = *p++;
		const unsigned short u = ( t >= 0x40 && t <= 0xFC ) ? cp932_dbcs[li * 189 + (t - 0x40)] : 0;
		o += static_cast<wchar_t>(u ? u : 0x30FB);
	}
	return o;
}

std::string		WtoSJIS(const std::wstring& str)
{
	std::string o;
	o.reserve(str.size() * 2);
	for ( std::wstring::const_iterator it = str.begin() ; it != str.end() ; ++it ) {
		const unsigned long c = static_cast<unsigned long>(*it);
		if ( c < 0x80 ) { o += static_cast<char>(c); continue; }
		unsigned int lo = 0, hi = cp932_enc_count;
		while ( lo < hi ) {
			const unsigned int mid = (lo + hi) / 2;
			if ( cp932_enc_ucs[mid] < c ) { lo = mid + 1; } else { hi = mid; }
		}
		if ( c <= 0xFFFF && lo < cp932_enc_count && cp932_enc_ucs[lo] == c ) {
			const unsigned short mb = cp932_enc_mb[lo];
			if ( mb > 0xFF ) { o += static_cast<char>(mb >> 8); }
			o += static_cast<char>(mb & 0xFF);
		}
		else {
			o += '?';	// like WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS)
		}
	}
	return o;
}

std::wstring	ACPtoW(const std::string& str) { return UTF8toW(str); }
std::string		WtoACP(const std::wstring& str) { return WtoUTF8(str); }

#elif defined(POSIX)

static std::string	iconv_convert('''),

# ---------------------------------------------------------------- 2. SAORI -> JavaScript bridge
('satori/SakuraDLLClient.h',
'''#ifdef POSIX
	void*   mModule;''',
'''#ifdef __EMSCRIPTEN__
	int     m_em_handle;	// sumika: handle from Module.saoriBridge.load (0 = none)
#endif
#ifdef POSIX
	void*   mModule;'''),
('satori/SakuraDLLClient.cpp',
'''#ifdef POSIX
#  include <dlfcn.h>''',
'''#ifdef __EMSCRIPTEN__
#  include <emscripten.h>
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
static char* em_request_marker(char*, long*) { return NULL; }	// never called; only makes mRequest non-NULL
#endif
#ifdef POSIX
#  include <dlfcn.h>'''),
('satori/SakuraDLLClient.cpp',
'''	m_version_reply_has_charset = true;
	mModule = NULL;''',
'''	m_version_reply_has_charset = true;
#ifdef __EMSCRIPTEN__
	m_em_handle = 0;
#endif
	mModule = NULL;'''),
('satori/SakuraDLLClient.cpp',
'''	memcpy(h, theRequest.c_str(), len + 1); //ZeroTermまで
	h = mRequest(h, &len);''',
'''	memcpy(h, theRequest.c_str(), len + 1); //ZeroTermまで
#ifdef __EMSCRIPTEN__
	{
		int out_len = 0;
		char* r = js_saori_request(m_em_handle, h, (int)len, &out_len);
		free(h);
		h = r;
		len = out_len;
	}
#else
	h = mRequest(h, &len);
#endif'''),
('satori/SakuraDLLClient.cpp',
'''#ifdef POSIX
    if (mModule != NULL) {
	    dlclose(mModule);
	}
#else''',
'''#if defined(__EMSCRIPTEN__)
	if ( m_em_handle > 0 ) {
		js_saori_unload(m_em_handle);
	}
	m_em_handle = 0;
#elif defined(POSIX)
    if (mModule != NULL) {
	    dlclose(mModule);
	}
#else'''),
('satori/SakuraDLLClient.cpp',
'''#ifdef POSIX
	mModule = dlopen(WtoUTF8(dll_fullpath).c_str(), RTLD_LAZY);''',
'''#ifdef __EMSCRIPTEN__
	m_em_handle = js_saori_load(WtoUTF8(dll_fullpath).c_str(), WtoUTF8(work_folder).c_str());
	if ( m_em_handle <= 0 ) {
		m_em_handle = 0;
		GetSender().sender() << L"failed." << std::endl;
		GetSender().errsender() << dll_fullpath + L": no JavaScript stand-in for this SAORI" << satori::endl;
		return false;
	}
	mModule = reinterpret_cast<void*>(1);
	mRequest = em_request_marker;
	GetSender().sender() << L"succeed." << std::endl;
	return true;
#endif
#ifdef POSIX
	mModule = dlopen(WtoUTF8(dll_fullpath).c_str(), RTLD_LAZY);'''),
# shiori_plugin: DLL files are not shipped to the browser, so skip the file checks and the dlopen probe.
('satori/shiori_plugin.cpp',
'''			// ファイルの存在を確認
			FILE*	fp = w_fopen(fullpath, L"rb");''',
'''#ifndef __EMSCRIPTEN__
			// ファイルの存在を確認
			FILE*	fp = w_fopen(fullpath, L"rb");'''),
('satori/shiori_plugin.cpp',
'''				return	false;
			}
			fclose(fp);
''',
'''				return	false;
			}
			fclose(fp);
#endif
'''),
('satori/shiori_plugin.cpp',
'''#ifdef POSIX
			// 環境変数 SAORI_FALLBACK_ALWAYS が定義されていて、且つ''',
'''#if defined(POSIX) && !defined(__EMSCRIPTEN__)
			// 環境変数 SAORI_FALLBACK_ALWAYS が定義されていて、且つ'''),

# ---------------------------------------------------------------- 3. resume load (page navigation) + save export
('satori/satori_load_unload.cpp',
'''	variables[L"起動回数"] = itos( zen2int(variables[L"起動回数"])+1 );''',
'''#ifdef __EMSCRIPTEN__
	extern bool g_em_resume_load;	// sumika: set by satori_load_resume(); a page navigation is not a boot
	if ( ! g_em_resume_load )
#endif
	variables[L"起動回数"] = itos( zen2int(variables[L"起動回数"])+1 );'''),
('satori/satori.h',
'''	bool	Save(bool isOnUnload=false);''',
'''	bool	Save(bool isOnUnload=false);
#ifdef __EMSCRIPTEN__
	bool	EmSave() { return is_dic_loaded ? Save(false) : false; }	// sumika: write savedata without unloading
#endif'''),
('satori/SakuraDLLHost.cpp',
'''extern "C" SATORI_EXPORT int load(char* i_data, long i_data_len) {''',
'''#ifdef __EMSCRIPTEN__
bool g_em_resume_load = false;

// sumika: same as load(), but does not count a boot (起動回数). Used when a page navigation restarts the engine.
extern "C" SATORI_EXPORT int satori_load_resume(char* i_data, long i_data_len) {
    wstring the_base_folder = UTF8toW(to_bytes(i_data, i_data_len));
    free(i_data);
    g_em_resume_load = true;
    int r = 0;
    try {
        r = SakuraDLLHost::I()->load(the_base_folder);
    }
    catch ( ... ) {
        r = 0;
    }
    g_em_resume_load = false;
    return r;
}

// sumika: write satori_savedata.txt now (a page can go away at any time). 1 = written.
extern "C" SATORI_EXPORT int satori_save(void) {
    try {
        Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
        return ( s != NULL && s->EmSave() ) ? 1 : 0;
    }
    catch ( ... ) {
        return 0;
    }
}
#endif

extern "C" SATORI_EXPORT int load(char* i_data, long i_data_len) {'''),

# ---------------------------------------------------------------- 4. no log spill to stderr unless a log handler is set
('_/Sender.cpp',
'''bool Sender::initialize()
{
#ifdef POSIX
	return true;''',
'''bool Sender::initialize()
{
#if defined(POSIX) && defined(__EMSCRIPTEN__)
	return false;	// sumika: logs only go to Set_loghandler (stderr would be console.error in a page)
#elif defined(POSIX)
	return true;'''),
]

# ---------------------------------------------------------------- 6. random-talk countdown survives page navigation
PATCHES += [
('satori/satori.h',
'''	bool	EmSave() { return is_dic_loaded ? Save(false) : false; }	// sumika: write savedata without unloading''',
'''	bool	EmSave() { return is_dic_loaded ? Save(false) : false; }	// sumika: write savedata without unloading
	int		EmTalkCount() const { return talk_interval_count; }	// sumika: random-talk countdown (seconds)
	int		EmSinceLastTalk() const { return second_from_last_talk; }
	void	EmSetTalkState(int count, int since) { if ( talk_interval > 0 ) { talk_interval_count = count; } second_from_last_talk = since; }'''),
('satori/SakuraDLLHost.cpp',
'''        return ( s != NULL && s->EmSave() ) ? 1 : 0;
    }
    catch ( ... ) {
        return 0;
    }
}
#endif''',
'''        return ( s != NULL && s->EmSave() ) ? 1 : 0;
    }
    catch ( ... ) {
        return 0;
    }
}

// sumika: Satori's random-talk countdown lives in memory only; the runtime carries it across page loads.
extern "C" SATORI_EXPORT int satori_get_talk_count(void) {
    Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
    return s ? s->EmTalkCount() : 0;
}
extern "C" SATORI_EXPORT int satori_get_since_last_talk(void) {
    Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
    return s ? s->EmSinceLastTalk() : 0;
}
extern "C" SATORI_EXPORT void satori_set_talk_state(int count, int since) {
    Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
    if ( s ) { s->EmSetTalkState(count, since); }
}
#endif'''),
]

# ---------------------------------------------------------------- 7. session clock: uptime runs from the ghost's cold boot
# SUMMARY section 2.1 P7. posix_get_current_sec() (WASM: the worker's age) feeds （単純起動秒）/（起動時…） (now - at_load),
# the total (now - at_load + total) and （ＯＳ起動…）. With Module.bootEpochMs set it counts from the ghost's last cold
# boot instead, and a resume load moves at_load to that zero. The wall clock is read once per worker; after that the
# clock runs on performance.now, monotonic like GetTickCount64, so a date change never reaches the saved total.
PATCHES += [
('satori/posix_utils.h',
'''// OS を起動してからの経過秒（Windows の GetTickCount64 / 1000 と同じ意味）
inline unsigned long posix_get_current_sec() {
#ifdef POSIX
	struct timespec ts;''',
'''#ifdef __EMSCRIPTEN__
// sumika P7: whole seconds since Module.bootEpochMs, or -1 without one (EM_JS in SakuraDLLHost.cpp)
extern "C" __attribute__((import_module("env"), import_name("em_boot_seconds"))) double em_boot_seconds(void);
#endif

// OS を起動してからの経過秒（Windows の GetTickCount64 / 1000 と同じ意味）
inline unsigned long posix_get_current_sec() {
#ifdef POSIX
#ifdef __EMSCRIPTEN__
	// sumika P7: a page load restarts the worker, not the ghost
	{ const double s = em_boot_seconds(); if ( s >= 0 ) { return static_cast<unsigned long>(s); } }
#endif
	struct timespec ts;'''),
('satori/satori.h',
'''	void	EmSetTalkState(int count, int since) { if ( talk_interval > 0 ) { talk_interval_count = count; } second_from_last_talk = since; }''',
'''	void	EmSetTalkState(int count, int since) { if ( talk_interval > 0 ) { talk_interval_count = count; } second_from_last_talk = since; }
	// sumika P7 (SUMMARY 2.1): after a resume load, since-load counts from the clock's zero (the cold boot) and the
	// total goes on from the saved one: now - 0 + (saved - at_load). Unsigned on purpose: at_load (seconds since the cold
	// boot) may exceed the saved total, and the sum wraps back to it; a clamp would drop the total from before the boot.
	// That needs now >= the old at_load: em_boot_seconds is monotonic within the worker.
	void	EmResumeClock() { sec_count_total -= sec_count_at_load; sec_count_at_load = 0; }'''),
('satori/SakuraDLLHost.cpp',
'''#ifdef __EMSCRIPTEN__
bool g_em_resume_load = false;''',
'''#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// sumika P7: the clock behind posix_get_current_sec(). Module.bootEpochMs = epoch ms of the ghost's last cold boot,
// set by the runtime before load(); without it, -1 (the worker's age). SUMMARY 2.1: Date.now is read once
// (at load), then performance.now advances it, so the clock never steps within a worker; an epoch in the future is 0.
EM_JS(double, em_boot_seconds, (), {
	var e = Module['bootEpochMs'];
	if (!(e > 0)) return -1;
	if (Module['emClockBaseMs'] === undefined) {
		Module['emClockBaseMs'] = Math.max(0, Date.now() - e);
		Module['emClockPerf0'] = performance.now();
	}
	return Math.floor((Module['emClockBaseMs'] + performance.now() - Module['emClockPerf0']) / 1000);
});

bool g_em_resume_load = false;'''),
('satori/SakuraDLLHost.cpp',
'''        r = SakuraDLLHost::I()->load(the_base_folder);
    }''',
'''        r = SakuraDLLHost::I()->load(the_base_folder);
        Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
        if ( r && s ) { s->EmResumeClock(); }	// sumika P7: a resume is not a load
    }'''),
]

# ---------------------------------------------------------------- 8. Satori's FMO view from the page
# satori-wasm.md section 8 P8. updateGhostsInfo() (（FMOn…）, （Xの存在）, （Xのサーフェス）) reads SSP's shared
# "SakuraUnicode" FMO on Windows and is a no-op on POSIX. In WebAssembly it is compiled (SakuraFMO, satoriFMO) and reads
# Module.fmoText, the text the page builds (src/core/fmo.js) and the worker sets before a request. No text = the FMO
# cannot be opened: the list read last stays (none at first, so the built-ins answer as without P8).
PATCHES += [
# satori.h: the POSIX no-op stays for other POSIX builds; WebAssembly compiles the real one (satoriFMO.cpp)
('satori/satori.h',
'''#ifdef POSIX
	bool updateGhostsInfo() { return true; } // 何もしない。
#else''',
'''#if defined(POSIX) && !defined(__EMSCRIPTEN__)
	bool updateGhostsInfo() { return true; } // 何もしない。
#else'''),

# SakuraFMO.cpp: no Windows file mapping; the FMO text comes from Module.fmoText
('satori/SakuraFMO.cpp',
'''#include "SakuraFMO.h"
#include "../_/FMO.h"
#include "../_/Sender.h"''',
'''#include "SakuraFMO.h"
#ifndef __EMSCRIPTEN__
#include "../_/FMO.h"
#endif
#include "../_/Sender.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <stdlib.h>
// sumika P8: SSP's shared "SakuraUnicode" FMO as the page builds it (Module.fmoText: lines "<id>.<key>\\x01<value>\\r\\n",
// UTF-8), read whenever Satori reads the FMO. NULL while the page has sent none (= the FMO cannot be opened).
EM_JS(char*, js_fmo_text, (), {
	var t = Module['fmoText'];
	if (typeof t !== 'string') return 0;
	var n = lengthBytesUTF8(t) + 1;
	var p = _malloc(n);
	stringToUTF8(t, p, n);
	return p;
});

static bool	em_read_fmo(std::string& o)
{
	char* p = js_fmo_text();
	if ( p == NULL ) {
		return	false;
	}
	o = p;
	free(p);
	return	true;
}
#endif'''),
('satori/SakuraFMO.cpp',
'''// FMOの内容をバイト列で読む。先頭4バイトはサイズ（自身を含む）。
static bool	read_fmo(''',
'''#ifndef __EMSCRIPTEN__
// FMOの内容をバイト列で読む。先頭4バイトはサイズ（自身を含む）。
static bool	read_fmo('''),
('satori/SakuraFMO.cpp',
'''	fmo.unmap(p);
	fmo.close();
	return	true;
}''',
'''	fmo.unmap(p);
	fmo.close();
	return	true;
}
#endif'''),
('satori/SakuraFMO.cpp',
'''	if ( read_fmo(L"SakuraUnicode", bytes) ) {
		text = UTF8toW(bytes);
	}
	else if ( read_fmo(L"Sakura", bytes) ) {
		text = ACPtoW(bytes);
	}
	else {''',
'''#ifdef __EMSCRIPTEN__
	if ( em_read_fmo(bytes) ) {
		text = UTF8toW(bytes);
	}
#else
	if ( read_fmo(L"SakuraUnicode", bytes) ) {
		text = UTF8toW(bytes);
	}
	else if ( read_fmo(L"Sakura", bytes) ) {
		text = ACPtoW(bytes);
	}
#endif
	else {'''),

# satoriFMO.cpp: no exe folder in WebAssembly; the ghost's own entry is the one whose ghostpath + ghost/master/ is
# Satori's base folder (/ghost/master/), with '/' as the separator
('satori/satoriFMO.cpp',
'''	if ( mExeFolder==L"" )
	{
		return	false;
	}''',
'''#ifndef __EMSCRIPTEN__
	if ( mExeFolder==L"" )
	{
		return	false;
	}
#endif'''),
('satori/satoriFMO.cpp',
'''(m[L"ghostpath"]+L"ghost\\\\master\\\\")''',
'''(m[L"ghostpath"]+DIR_FMO_MASTER)'''),
('satori/satoriFMO.cpp',
'''bool	Satori::updateGhostsInfo() {''',
'''#ifdef __EMSCRIPTEN__
#define	DIR_FMO_MASTER	L"ghost/master/"	// sumika P8: the engine's file system uses '/'
#else
#define	DIR_FMO_MASTER	L"ghost\\\\master\\\\"
#endif

bool	Satori::updateGhostsInfo() {'''),
]
