"""Patches applied to the UTF-8 copy of KAWARI 8.2.8's sources (vendor/kawari-8.2.8/build/src) before compiling to
WebAssembly; shaped like engines/satori/patches.py. The ids are the plan's (scratch kawari/plan.md section 1.3, to be
docs/research/kawari-wasm.md section 5). Each entry is (file, old, new); `old` must occur exactly once (sources are
LF-normalised first). Every behaviour change is under __EMSCRIPTEN__ except K1-K3. The code they call is Sumika's own
glue, engines/kawari/em_kawari.cpp / em_kawari.h (copied next to the sources by build.py).

K1, K2: modern-compiler fixes (no behaviour change; upstream code that VC++/gcc 3 accepted).
K3: the lexer's character tables indexed by signed char (read outside the 256-entry tables for 0x80-0xFF).
K4: code page 932 <-> UTF-8 (engines/common/gen_cp932.py's table, in em_kawari.cpp; misc/l10n.h includes em_kawari.h),
    and the SHIORI boundary: `load` gets the folder in code page 932; a request that says Charset: UTF-8 is handed to
    Kawari in code page 932 (saying Shift_JIS) and its reply comes back in UTF-8 (saying UTF-8), as SSP converts at its
    side. Any other request passes unchanged.
K5: SAORI -> Module.saoriBridge (Satori's P2 contract: UTF-8 both ways), instead of dlopen().
K6: file names: Kawari holds paths in code page 932 (as the Windows ANSI file API takes them), MEMFS wants UTF-8.
K7: getenv finds nothing (Emscripten's HOME/USER/PATH are not the visitor's; YAYA's N8).
K8: the log goes to Module.kawariLog(line) in UTF-8, errors and warnings by default (Module.kawariLogLevel); a ghost's
    own loglevel still applies.
K9: `logfile NAME` and `logfile -` point the log at the same sink; no file is ever created (a .txt log would pass the
    *.log guard). `logfile` alone stops logging, as in Kawari.
K10: textload drops the CR of each CRLF line (the DLL reads in Windows text mode).
K11: save, savecrypt, textsave and textappend end lines with CRLF (the DLL writes in Windows text mode).
K12: the resume snapshot's hooks: Load hands its engine to the glue (Unload and the destructor take it back), TEntry
     says whether it is write-protected, the garbage collector reports the word ids it frees, and the dictionary loader
     and KIS's `function` report each definition (so an entry load wrote otherwise, from the clock or a random pick, is
     carried).
"""

PATCHES = [
# ---------------------------------------------------------------- K1. TMMap: members of a dependent base need this->
('misc/mmap.h',
'''		typename std::multimap<KeyType, DataType>::iterator it=lower_bound(key);''',
'''		typename std::multimap<KeyType, DataType>::iterator it=this->lower_bound(key);'''),
('misc/mmap.h',
'''		if(it==upper_bound(key)) it=insert(typename TMMap<KeyType,DataType>::value_type(key,DataType()));''',
'''		if(it==this->upper_bound(key)) it=this->insert(typename TMMap<KeyType,DataType>::value_type(key,DataType()));'''),
('misc/mmap.h',
'''		insert(typename TMMap::value_type(key,data));''',
'''		this->insert(typename TMMap::value_type(key,data));'''),

# ---------------------------------------------------------------- K2. C++11: "x"MACRO is a user-defined literal; add spaces
('shiori/kawari_shiori.cpp',
'''			response.SetStartline("SHIORI/"SHIORIVER" 500 Internal Server Error");
		} else {
			response.SetStartline("SAORI/"SAORIVER" 500 Internal Server Error");''',
'''			response.SetStartline("SHIORI/" SHIORIVER " 500 Internal Server Error");
		} else {
			response.SetStartline("SAORI/" SAORIVER " 500 Internal Server Error");'''),
('shiori/kawari_shiori.cpp',
'''					aistr=KAWARI_MAJOR"."KAWARI_MINOR"."KAWARI_SUBMINOR;''',
'''					aistr=KAWARI_MAJOR "." KAWARI_MINOR "." KAWARI_SUBMINOR;'''),
('shiori/kawari_shiori.cpp',
'''				response["Version"]=KAWARI_MAJOR"."KAWARI_MINOR"."KAWARI_SUBMINOR;''',
'''				response["Version"]=KAWARI_MAJOR "." KAWARI_MINOR "." KAWARI_SUBMINOR;'''),
('shiori/kawari_shiori.cpp',
'''		response.SetStartline("SHIORI/"SHIORIVER" "+statusheader);
	else
		response.SetStartline("SAORI/"SAORIVER" "+statusheader);''',
'''		response.SetStartline("SHIORI/" SHIORIVER " "+statusheader);
	else
		response.SetStartline("SAORI/" SAORIVER " "+statusheader);'''),

# ---------------------------------------------------------------- K3. lexer tables: index by unsigned char
# char is signed (wasm32 as MSVC x86): a byte 0xA0-0xDF (half-width katakana, not a lead byte) read map[-96..-33],
# outside the 256-entry tables. Whatever the DLL read there depended on its data layout; the tables' upper half says
# what was meant (1: accepted).
('libkawari/kawari_lexer.cpp',
'''		}else if (map[ch]){
			ret+=ch;''',
'''		}else if (map[(unsigned char)ch]){
			ret+=ch;'''),
('libkawari/kawari_lexer.cpp',
'''	}else if ((lex_map[(int)m][ch]|(char)iskanji1st(ch))){
		// ベア文字列
		return Token::T_LITERAL;''',
'''	}else if ((lex_map[(int)m][(unsigned char)ch]|(char)iskanji1st(ch))){
		// ベア文字列
		return Token::T_LITERAL;'''),
('libkawari/kawari_lexer.cpp',
'''	pp->getch(ch);
	if ((lex_map[(int)m][ch]|(char)iskanji1st(ch))){''',
'''	pp->getch(ch);
	if ((lex_map[(int)m][(unsigned char)ch]|(char)iskanji1st(ch))){'''),
('libkawari/kawari_lexer.cpp',
'''		} else if(!map[c]) {''',
'''		} else if(!map[(unsigned char)c]) {'''),

# ---------------------------------------------------------------- K4. code page 932 <-> UTF-8, SHIORI boundary
('misc/l10n.h',
'''// SJIS Char String -> SJIS Wide Char String
std::wstring ctow(const std::string& s);''',
'''// SJIS Char String -> SJIS Wide Char String
std::wstring ctow(const std::string& s);
//---------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
// sumika: code page 932 <-> UTF-8, the header helpers, the log sink, the CRLF writer and the snapshot hooks
#include "em_kawari.h"
#endif'''),
('shiori/shiori.cpp',
'''// モジュール読み込み直後に呼ばれる
SHIORI_EXPORT BOOL SHIORI_CALL load(const MEMORY_HANDLE h,long len)
{
	handle=TKawariShioriFactory::GetFactory().CreateInstance(
		string((const char*)h, len));''',
'''// モジュール読み込み直後に呼ばれる
SHIORI_EXPORT BOOL SHIORI_CALL load(const MEMORY_HANDLE h,long len)
{
#ifdef __EMSCRIPTEN__
	// sumika: the folder comes in UTF-8 (MEMFS); Kawari keeps every path in code page 932 (K6 converts it back at
	// each file call)
	handle=TKawariShioriFactory::GetFactory().CreateInstance(
		EmUtf8ToCp932(string((const char*)h, len)));
#else
	handle=TKawariShioriFactory::GetFactory().CreateInstance(
		string((const char*)h, len));
#endif'''),
('shiori/shiori.cpp',
'''	string resstr=TKawariShioriFactory::GetFactory().RequestInstance(
		handle, string((const char*)h, *len));

	SHIORI_FREE(h);''',
'''#ifdef __EMSCRIPTEN__
	// sumika: Kawari reads and writes Shift_JIS only, whatever the request says (kawari_shiori.cpp answers
	// "Charset: Shift_JIS" always). SSP converts at its side; here a request that says Charset: UTF-8 is converted to
	// code page 932 (and says Shift_JIS, as SSP's request would), and the reply back to UTF-8 (and says UTF-8).
	string reqstr((const char*)h, *len);
	SHIORI_FREE(h);
	string cs=EmHeader(reqstr, "Charset");
	for (string::size_type i=0; i<cs.size(); i++) cs[i]=tolower((unsigned char)cs[i]);
	const bool em_utf8=(cs=="utf-8")||(cs=="utf8");
	if (em_utf8) reqstr=EmSetHeader(EmUtf8ToCp932(reqstr), "Charset", "Shift_JIS");
	string resstr=TKawariShioriFactory::GetFactory().RequestInstance(handle, reqstr);
	if (em_utf8) resstr=EmSetHeader(EmCp932ToUtf8(resstr), "Charset", "UTF-8");
#else
	string resstr=TKawariShioriFactory::GetFactory().RequestInstance(
		handle, string((const char*)h, *len));

	SHIORI_FREE(h);
#endif'''),
('shiori/shiori.cpp',
'''#include "shiori/kawari_shiori.h"
#include "include/shiori.h"''',
'''#include "shiori/kawari_shiori.h"
#include "include/shiori.h"
#include "misc/l10n.h"
#include <cstring>
#include <cctype>'''),

# ---------------------------------------------------------------- K5. SAORI -> Module.saoriBridge
('saori/saori_native.cpp',
'''#if defined(WIN32)||defined(_WIN32)||defined(_Windows)||defined(__CYGWIN__)
// Win32
SAORI_HANDLE load_library(const string &file){''',
'''#if defined(__EMSCRIPTEN__)
} // namespace
// sumika: SAORI calls go to JavaScript stand-ins (Module.saoriBridge, the contract of Satori's patch P2) instead of a
// DLL: load(path, dir) -> handle > 0 (0: no stand-in); request(handle, Uint8Array) -> string | Uint8Array; unload(h).
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
namespace {
// LoadLibrary hands out one module per DLL (the same HMODULE again while it is loaded); the bridge makes a stand-in per
// load, so one handle per path is kept here, counted like LoadLibrary / FreeLibrary. The path key is case-insensitive
// (NTFS), on single-byte characters only (a trail byte is no letter).
struct em_saori_lib { SAORI_HANDLE handle; int count; };
map<string, em_saori_lib> em_saori_libs;
string em_saori_key(const string &file){
	wstring w=ctow(file);
	for (unsigned int i=0; i<w.size(); i++) if (w[i]<0x80) w[i]=tolower((int)w[i]);
	return wtoc(w);
}
SAORI_HANDLE load_library(const string &file){
	const string key=em_saori_key(file);
	map<string, em_saori_lib>::iterator it=em_saori_libs.find(key);
	if (it!=em_saori_libs.end()){
		it->second.count++;
		return it->second.handle;
	}
	const string path=EmFsPath(file);
	string::size_type pos=path.rfind('/');
	const string dir=(pos==string::npos) ? string("") : path.substr(0, pos+1);
	int h=js_saori_load(path.c_str(), dir.c_str());
	if (h<=0) return 0;
	em_saori_lib lib={ (SAORI_HANDLE)h, 1 };
	em_saori_libs[key]=lib;
	return (SAORI_HANDLE)h;
}
// the stand-in's unload (the SAORI's own unload() and FreeLibrary in one): after it, a new load makes a new stand-in
void em_saori_unload(SAORI_HANDLE handle){
	for (map<string, em_saori_lib>::iterator it=em_saori_libs.begin(); it!=em_saori_libs.end(); it++){
		if (it->second.handle==handle){
			em_saori_libs.erase(it);
			js_saori_unload((int)handle);
			return;
		}
	}
}
void unload_library(SAORI_HANDLE handle){
	for (map<string, em_saori_lib>::iterator it=em_saori_libs.begin(); it!=em_saori_libs.end(); it++){
		if (it->second.handle==handle){
			if ((--it->second.count)<=0) em_saori_unload(handle);
			return;
		}
	}
}
void *get_symbol(SAORI_HANDLE handle, const std::string &name){
	return NULL;
}
#elif defined(WIN32)||defined(_WIN32)||defined(_Windows)||defined(__CYGWIN__)
// Win32
SAORI_HANDLE load_library(const string &file){'''),
('saori/saori_native.cpp',
'''#ifndef KAWARI_MS
static string str_getenv(const string& name) {''',
'''#ifdef __EMSCRIPTEN__
#	include <emscripten.h>
#	include "misc/l10n.h"
#	include <cctype>
#endif
#if !defined(KAWARI_MS) && !defined(__EMSCRIPTEN__)
static string str_getenv(const string& name) {'''),
('saori/saori_native.cpp',
'''// 初期化
bool TModuleNative::Initialize(void){
	func_load=''',
'''// 初期化
bool TModuleNative::Initialize(void){
#ifdef __EMSCRIPTEN__
	// sumika: the stand-in was loaded by load_library (the bridge's load is the DLL's load())
	func_load=NULL; func_unload=NULL; func_request=NULL;
	return true;
#endif
	func_load='''),
('saori/saori_native.cpp',
'''bool TModuleNative::Unload(void){
	if (!func_unload) return true;''',
'''bool TModuleNative::Unload(void){
#ifdef __EMSCRIPTEN__
	GetFactory().GetLogger().GetStream(LOG_INFO) << "[SAORI Native] unload()" << endl;
	em_saori_unload(handle);
	return true;
#endif
	if (!func_unload) return true;'''),
('saori/saori_native.cpp',
'''string TModuleNative::Request(const string &req){
	if (!func_request) return ("");''',
'''string TModuleNative::Request(const string &req){
#ifdef __EMSCRIPTEN__
	{
		// Kawari asks in Shift_JIS (code page 932); the stand-ins speak UTF-8 (the bridge's contract)
		string cs=EmHeader(req, "Charset");
		for (string::size_type i=0; i<cs.size(); i++) cs[i]=tolower((unsigned char)cs[i]);
		const bool sjis=(cs=="shift_jis")||(cs=="sjis")||(cs=="x-sjis")||(cs=="cp932")||(cs=="windows-31j")||(cs=="");
		string r=sjis ? EmSetHeader(EmCp932ToUtf8(req), "Charset", "UTF-8") : req;
		int out_len=0;
		char *p=js_saori_request((int)handle, r.data(), (int)r.size(), &out_len);
		string res(p, out_len);
		free(p);
		string rcs=EmHeader(res, "Charset");
		for (string::size_type i=0; i<rcs.size(); i++) rcs[i]=tolower((unsigned char)rcs[i]);
		if (sjis&&((rcs=="utf-8")||(rcs=="utf8")))
			res=EmSetHeader(EmUtf8ToCp932(res), "Charset", "Shift_JIS");
		return res;
	}
#endif
	if (!func_request) return ("");'''),
('saori/saori_native.cpp',
'''#endif
//---------------------------------------------------------------------------
namespace {
//---------------------------------------------------------------------------
// prototypes''',
'''#endif
#ifdef __EMSCRIPTEN__
namespace { void em_saori_unload(saori::SAORI_HANDLE handle); }
#endif
//---------------------------------------------------------------------------
namespace {
//---------------------------------------------------------------------------
// prototypes'''),

# ---------------------------------------------------------------- K6. file names: code page 932 -> UTF-8 at each call
('libkawari/kawari_engine.cpp',
'''	ifstream ifs;
	ifs.open(filename.c_str(), ios::binary|ios::in);''',
'''	ifstream ifs;
#ifdef __EMSCRIPTEN__
	ifs.open(EmFsPath(filename).c_str(), ios::binary|ios::in);
#else
	ifs.open(filename.c_str(), ios::binary|ios::in);
#endif'''),
('libkawari/kawari_engine.cpp',
'''	ofstream ofs;
	ofs.open(filename.c_str());

	if(!ofs.is_open()) return(false);

	ofs << "#" << endl << "# Kawari saved file" << endl << "#" << endl;''',
'''#ifdef __EMSCRIPTEN__
	// sumika (K6, K11): the path in UTF-8 for MEMFS; lines end in CRLF, as the DLL's text-mode ofstream writes them
	EmTextOfstream ofs;
	ofs.open(EmFsPath(filename).c_str());
#else
	ofstream ofs;
	ofs.open(filename.c_str());
#endif

	if(!ofs.is_open()) return(false);

	ofs << "#" << endl << "# Kawari saved file" << endl << "#" << endl;'''),
('kis/kis_file.cpp',
'''	ifstream ifs;
	ifs.open(filename.c_str());''',
'''	ifstream ifs;
#ifdef __EMSCRIPTEN__
	ifs.open(EmFsPath(filename).c_str());
#else
	ifs.open(filename.c_str());
#endif'''),
('kis/kis_file.cpp',
'''	ofstream ofs;
	if(flag) ofs.open(filename.c_str());
	 else ofs.open(filename.c_str(), ios::app);''',
'''#ifdef __EMSCRIPTEN__
	// sumika (K6, K11): textsave / textappend: the path in UTF-8 for MEMFS; lines end in CRLF (Windows text mode)
	EmTextOfstream ofs;
	if(flag) ofs.open(EmFsPath(filename).c_str());
	 else ofs.open(EmFsPath(filename).c_str(), ios::app);
#else
	ofstream ofs;
	if(flag) ofs.open(filename.c_str());
	 else ofs.open(filename.c_str(), ios::app);
#endif'''),
('kis/kis_file.cpp',
'''	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");

	Engine->ClearEntry(args[1]);

	while((direntry=readdir(dirhandle))!=NULL) {
		string entry=direntry->d_name;''',
'''#ifdef __EMSCRIPTEN__
	if((dirhandle=opendir(EmFsPath(dirname).c_str()))==NULL) return("");
#else
	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");
#endif

	Engine->ClearEntry(args[1]);

	while((direntry=readdir(dirhandle))!=NULL) {
#ifdef __EMSCRIPTEN__
		string entry=EmUtf8ToCp932(direntry->d_name);
#else
		string entry=direntry->d_name;
#endif'''),
('kis/kis_file.cpp',
'''	if(stat(dirname.c_str(),&buf)) return("");''',
'''#ifdef __EMSCRIPTEN__
	if(stat(EmFsPath(dirname).c_str(),&buf)) return("");
#else
	if(stat(dirname.c_str(),&buf)) return("");
#endif'''),
('kis/kis_file.cpp',
'''	if(stat(pathname.c_str(),&buf)) return("");''',
'''#ifdef __EMSCRIPTEN__
	if(stat(EmFsPath(pathname).c_str(),&buf)) return("");
#else
	if(stat(pathname.c_str(),&buf)) return("");
#endif'''),
('kis/kis_file.cpp',
'''	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");

	string str="0";
	while((direntry=readdir(dirhandle))!=NULL) {
		string entry=direntry->d_name;''',
'''#ifdef __EMSCRIPTEN__
	if((dirhandle=opendir(EmFsPath(dirname).c_str()))==NULL) return("");
#else
	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");
#endif

	string str="0";
	while((direntry=readdir(dirhandle))!=NULL) {
#ifdef __EMSCRIPTEN__
		string entry=EmUtf8ToCp932(direntry->d_name);
#else
		string entry=direntry->d_name;
#endif'''),
('kis/kis_system.cpp',
'''#include "misc/misc.h"
using namespace kawari_log;''',
'''#include "misc/misc.h"
#include "misc/l10n.h"
using namespace kawari_log;'''),
('libkawari/kawari_engine.cpp',
'''#include <fstream>''',
'''#include <fstream>
#include "misc/l10n.h"'''),

# ---------------------------------------------------------------- K7. getenv: no environment
('kis/kis_system.cpp',
'''	char *p;
	p=getenv(args[1].c_str());
	if(p==NULL) return("");''',
'''	char *p;
#ifdef __EMSCRIPTEN__
	p=NULL;		// sumika: Emscripten's HOME, USER, PATH are not the visitor's (YAYA's N8)
#else
	p=getenv(args[1].c_str());
#endif
	if(p==NULL) return("");'''),

# ---------------------------------------------------------------- K8, K12. Load: the log sink; the engine to the glue
('shiori/kawari_shiori.cpp',
'''// SHIORI/2.x API
//---------------------------------------------------------------------------
// DLLロード時に呼ばれる
bool TKawariShioriAdapter::Load(const string& datapath)
{''',
'''// SHIORI/2.x API
//---------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
#include "misc/l10n.h"
#endif
// DLLロード時に呼ばれる
bool TKawariShioriAdapter::Load(const string& datapath)
{
#ifdef __EMSCRIPTEN__
	// sumika (K8): Kawari's log (a null stream at level 0) goes line by line to Module.kawariLog(text) in UTF-8 when the
	// page set it, from Module.kawariLogLevel (default error|warning); kawarirc.kis's loglevel may change the level
	{
		const int lv=EmLogLevel();
		if (lv>=0){
			Engine.GetLogger().SetStream(EmLogStream());
			Engine.GetLogger().SetErrLevel((unsigned int)lv);
		}
	}
	// sumika (K12): the snapshot exports (em_kawari.cpp) work on this engine
	EmSetEngine(&Engine);
#endif'''),

# ---------------------------------------------------------------- K9. logfile: the same sink, never a file
('kis/kis_system.cpp',
'''		if (args[1]=="-"){
			GetLogger().SetStreamStdOut();
		}else{
			filestream=new ofstream(CanonicalPath(Engine->GetDataPath(), args[1]).c_str());
			if (filestream)
				GetLogger().SetStream(filestream);
		}''',
'''#ifdef __EMSCRIPTEN__
		// sumika (K9): a ghost's log (a file, or stdout for "-") goes to Module.kawariLog like the rest (shown with
		// ?sumika-debug); no file is created. Without a Module.kawariLog it goes nowhere.
		GetLogger().SetStream(EmLogStream());
#else
		if (args[1]=="-"){
			GetLogger().SetStreamStdOut();
		}else{
			filestream=new ofstream(CanonicalPath(Engine->GetDataPath(), args[1]).c_str());
			if (filestream)
				GetLogger().SetStream(filestream);
		}
#endif'''),

# ---------------------------------------------------------------- K10. textload: CRLF -> LF as Windows text mode reads
('kis/kis_file.cpp',
'''	while(getline(ifs,buff)) {
		entry.Push(Engine->CreateStrWord(buff));''',
'''	while(getline(ifs,buff)) {
#ifdef __EMSCRIPTEN__
		// sumika (K10): the DLL opens the file in Windows text mode, where a CR before LF is dropped; a CR that ends the
		// file without an LF stays [infer: the CRT's text-mode read]
		if(!ifs.eof()&&buff.size()&&(buff[buff.size()-1]=='\\r')) buff.erase(buff.size()-1);
#endif
		entry.Push(Engine->CreateStrWord(buff));'''),

# ---------------------------------------------------------------- K11: in the K6 entries of SaveKawariDict and textsave

# ---------------------------------------------------------------- K12. the resume snapshot's hooks
('shiori/kawari_shiori.cpp',
'''	Engine.GetLogger().GetStream(LOG_INFO) << "[SHIORI/SAORI Adapter] Unload." << endl;''',
'''	Engine.GetLogger().GetStream(LOG_INFO) << "[SHIORI/SAORI Adapter] Unload." << endl;
#ifdef __EMSCRIPTEN__
	// sumika (K12): no snapshot after OnUnload: the ghost saved itself
	EmClearEngine(&Engine);
#endif'''),
('shiori/kawari_shiori.h',
'''#include "libkawari/kawari_version.h"''',
'''#include "libkawari/kawari_version.h"
#ifdef __EMSCRIPTEN__
#include "em_kawari.h"
#endif'''),
('shiori/kawari_shiori.h',
'''	virtual ~TKawariShioriAdapter() {}''',
'''#ifdef __EMSCRIPTEN__
	// sumika (K12): the glue forgets this engine
	virtual ~TKawariShioriAdapter() { EmClearEngine(&Engine); }
#else
	virtual ~TKawariShioriAdapter() {}
#endif'''),
('libkawari/kawari_ns.h',
'''	void WriteProtect(void);''',
'''	void WriteProtect(void);
#ifdef __EMSCRIPTEN__
	// sumika (K12): the resume snapshot leaves write-protected entries out (they refuse writes)
	bool IsWriteProtected(void) const { return IsValid()&&(ns->ProtectedEntry.count(entry)!=0); }
#endif'''),
('libkawari/kawari_dict.cpp',
'''void TNS_KawariDictionary::DeleteContext(void){
	if (ContextStack.size()){
		if(ContextStack.back()) delete ContextStack.back();
		ContextStack.pop_back();
	}
	if (!ContextStack.size()){''',
'''#ifdef __EMSCRIPTEN__
void EmWordCollected(unsigned int id);		// sumika (K12): engines/kawari/em_kawari.cpp
#endif
void TNS_KawariDictionary::DeleteContext(void){
	if (ContextStack.size()){
		if(ContextStack.back()) delete ContextStack.back();
		ContextStack.pop_back();
	}
	if (!ContextStack.size()){
#ifdef __EMSCRIPTEN__
		// sumika (K12): the GC below frees these ids, and TWordCollection hands a freed id out again to the next new
		// word; the resume snapshot compares id lists, so it is told (the same test as the loops below)
		for (set<TWordID>::iterator it=Garbage.begin(); it!=Garbage.end(); it++)
			if (!GlobalNameSpace->ContainsWord(*it)) EmWordCollected(*it);
#endif'''),
('libkawari/kawari_engine.cpp',
'''					if (wid)
						for (vector<TEntry>::iterator eit=entrylist.begin(); eit!=entrylist.end(); eit++)
							eit->Push(wid);''',
'''					if (wid)
						for (vector<TEntry>::iterator eit=entrylist.begin(); eit!=entrylist.end(); eit++){
							eit->Push(wid);
#ifdef __EMSCRIPTEN__
							// sumika (K12): a definition; an entry load left otherwise (a script wrote it) is carried
							EmDefined(*eit, wid);
#endif
						}'''),
('libkawari/kawari_code.cpp',
'''				entry.Clear();
				entry.Push(id);''',
'''				entry.Clear();
				entry.Push(id);
#ifdef __EMSCRIPTEN__
				// sumika (K12): `function NAME body` defines with its zone's own text, as a dictionary line does
				EmDefinedOnly(entry, id);
#endif'''),
]

# em_kawari.cpp's exports (the snapshot, the encoder for the SSP view's descript.txt)
EXTRA_EXPORTS = ['_kawari_baseline', '_kawari_snapshot', '_kawari_restore', '_kawari_utf8_to_cp932']
EXTRA_CFLAGS = []
