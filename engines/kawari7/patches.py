r"""Patches applied to the escaped copy of KAWARI 7.5.0's sources (vendor/kawari-7.5.0/src; build.py writes every byte
0x80-0xFF as an octal escape and LF line ends) before compiling to WebAssembly; shaped like engines/kawari/patches.py.
Each entry is (file, old, new); `old` must occur exactly once. Raw strings: the sources' own backslashes (\x0d, the
octal escapes) are written as they stand. The code they call is Sumika's glue, engines/kawari7/em_kawari7.cpp /
em_kawari7.h (copied next to the sources by build.py). docs/research/kawari7-wasm.md section 5 lists them.

C1: config.h includes the glue under __EMSCRIPTEN__ (every source includes config.h first).
C2: modern-compiler fixes, no behaviour change (code VC++ 6 / gcc 2.95 accepted): dependent names need `typename` and
    `this->`, `pair` is std::pair, "x"MACRO is a C++11 user-defined literal, `transform(…, tolower)` is ambiguous.
C3: SAORI: TSaoriBinding is the glue's TSaoriBindingEm (Module.saoriBridge, the Kawari 8 build's K5 contract).
"""

PATCHES = [
# ---------------------------------------------------------------- C1. the glue in every unit
('config.h',
r'''#endif
//---------------------------------------------------------------------------
#endif''',
r'''#endif
//---------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
#include "em_kawari7.h"
#endif
//---------------------------------------------------------------------------
#endif'''),

# ---------------------------------------------------------------- C2. modern-compiler fixes
('misc/mmap.h',
r'''		std::multimap<KeyType,DataType>::iterator it;''',
r'''		typename std::multimap<KeyType,DataType>::iterator it;'''),
('misc/mmap.h',
r'''		it=lower_bound(key);''',
r'''		it=this->lower_bound(key);'''),
('misc/mmap.h',
r'''		if(it==upper_bound(key)) it=insert(pair<KeyType,DataType>(key,DataType()));''',
r'''		if(it==this->upper_bound(key)) it=this->insert(std::pair<KeyType,DataType>(key,DataType()));'''),
('misc/mmap.h',
r'''		insert(pair<KeyType,DataType>(key,data));''',
r'''		this->insert(std::pair<KeyType,DataType>(key,data));'''),
('libkawari/wordcollection.h',
r'''        for (vector<T*>::iterator it=WordList.begin(); it < WordList.end(); it++){''',
r'''        for (typename vector<T*>::iterator it=this->WordList.begin(); it < this->WordList.end(); it++){'''),
('libkawari/wordcollection.h',
r'''	TWordIDMap::const_iterator it=WordIDMap.find(word);''',
r'''	typename TWordIDMap::const_iterator it=WordIDMap.find(word);'''),
('misc/i18n.cpp',
r'''	transform(ret.begin(), ret.end(), ret.begin(), tolower);''',
r'''	transform(ret.begin(), ret.end(), ret.begin(), ::tolower);'''),
('misc/i18n.cpp',
r'''	transform(enc.begin(), enc.end(), enc.begin(), tolower);''',
r'''	transform(enc.begin(), enc.end(), enc.begin(), ::tolower);'''),
('libkawari/kawari.cpp',
r'''				response["Version"] = KAWARI_MAJOR "." KAWARI_MINOR "."KAWARI_SUBMINOR;''',
r'''				response["Version"] = KAWARI_MAJOR "." KAWARI_MINOR "." KAWARI_SUBMINOR;'''),
('libkawari/kawari.cpp',
r'''	string status="SHIORI/"SHIORIVER" "+statusheader+"\x0d\x0a";''',
r'''	string status="SHIORI/" SHIORIVER " "+statusheader+"\x0d\x0a";'''),
('shiori/shiori_interface.cpp',
r'''	return("SHIORI/"SHIORIVER);''',
r'''	return("SHIORI/" SHIORIVER);'''),

# ---------------------------------------------------------------- C3. SAORI -> Module.saoriBridge
('saori/saori.h',
r'''#elif defined(linux) || defined(__linux__)''',
r'''#elif defined(__EMSCRIPTEN__)
typedef TSaoriBindingEm TSaoriBinding;
#elif defined(linux) || defined(__linux__)'''),

# ---------------------------------------------------------------- C4. files in Windows text mode, paths for MEMFS
# kawari.ini, the dictionaries (`dict`, `load`), `text` / `textload` and `save` / `savecrypt`: EmTextIfstream and
# EmTextOfstream take Kawari's code page 932 path (MEMFS names it in UTF-8, '\' as '/'), read CRLF as LF and stop at a
# Ctrl+Z, and write '\n' as CRLF, as the DLL's msvcrt streams opened without ios::binary
('libkawari/kawari.cpp',
r'''bool TNS_KawariANI::LoadFile(const string &filename,const string &type)
{
	ifstream ifs;''',
r'''bool TNS_KawariANI::LoadFile(const string &filename,const string &type)
{
#ifdef __EMSCRIPTEN__
	EmTextIfstream ifs;
#else
	ifstream ifs;
#endif'''),
('libkawari/kawari.cpp',
r'''	if(type!="dict") return(false);

	ifstream ifs;''',
r'''	if(type!="dict") return(false);

#ifdef __EMSCRIPTEN__
	EmTextIfstream ifs;
#else
	ifstream ifs;
#endif'''),
('libkawari/kawari.cpp',
r'''bool TNS_KawariANI::LoadINI(const string &filename,const string &datapath,vector<string> &dictfiles)
{
	ifstream ifs;''',
r'''bool TNS_KawariANI::LoadINI(const string &filename,const string &datapath,vector<string> &dictfiles)
{
#ifdef __EMSCRIPTEN__
	EmTextIfstream ifs;
#else
	ifstream ifs;
#endif'''),
('libkawari/kawari_engine.cpp',
r'''bool TKawariEngine::LoadKawariDict(const string &filename)
{
	ifstream ifs;''',
r'''bool TKawariEngine::LoadKawariDict(const string &filename)
{
#ifdef __EMSCRIPTEN__
	EmTextIfstream ifs;
#else
	ifstream ifs;
#endif'''),
('libkawari/kawari_engine.cpp',
r'''bool TKawariEngine::LoadTextFile(const string &filename,const string &baseentry)
{
	ifstream ifs;''',
r'''bool TKawariEngine::LoadTextFile(const string &filename,const string &baseentry)
{
#ifdef __EMSCRIPTEN__
	EmTextIfstream ifs;
#else
	ifstream ifs;
#endif'''),
('libkawari/kawari_engine.cpp',
r'''bool TKawariEngine::SaveKawariDict(const string &filename,const vector<string>& entry,bool crypt) const
{
	ofstream ofs;''',
r'''bool TKawariEngine::SaveKawariDict(const string &filename,const vector<string>& entry,bool crypt) const
{
#ifdef __EMSCRIPTEN__
	EmTextOfstream ofs;
#else
	ofstream ofs;
#endif'''),

# ---------------------------------------------------------------- C5. readdir: the path for MEMFS, the names back in 932
('kis/kis_file.cpp',
r'''	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");''',
r'''#ifdef __EMSCRIPTEN__
	if((dirhandle=opendir(EmFsPath(dirname).c_str()))==NULL) return("");
#else
	if((dirhandle=opendir(dirname.c_str()))==NULL) return("");
#endif'''),
('kis/kis_file.cpp',
r'''		string entry=direntry->d_name;''',
r'''#ifdef __EMSCRIPTEN__
		string entry=EmUtf8ToCp932(direntry->d_name);
#else
		string entry=direntry->d_name;
#endif'''),

# ---------------------------------------------------------------- C6. `debug: log` -> Module.kawariLog, never kawari.log
('libkawari/kawari.h',
r'''	ofstream *LogFS;''',
r'''#ifdef __EMSCRIPTEN__
	std::ostream *LogFS;
#else
	ofstream *LogFS;
#endif'''),
('libkawari/kawari.cpp',
r'''					if(!LogFS) LogFS=new ofstream((datapath+"kawari.log").c_str());''',
r'''#ifdef __EMSCRIPTEN__
					if(!LogFS) LogFS=EmLogStream();
#else
					if(!LogFS) LogFS=new ofstream((datapath+"kawari.log").c_str());
#endif'''),
('libkawari/kawari.cpp',
r'''		(*LogFS) << "delete object." << endl;
		LogFS->close();
		delete LogFS;
	}
	delete Engine;''',
r'''		(*LogFS) << "delete object." << endl;
#ifndef __EMSCRIPTEN__
		LogFS->close();
		delete LogFS;
#endif
	}
#ifdef __EMSCRIPTEN__
	EmClearEngine(Engine);
#endif
	delete Engine;'''),

# ---------------------------------------------------------------- C8. the exports in the other engines' ABI
# load(path, len) frees the path (UTF-8 from the worker; Kawari holds paths in code page 932); request(req, &len) frees
# the request and returns a malloc'd reply of *len bytes (plus a NUL) that the caller frees. The bytes pass unchanged:
# the worker's SHIORI/2 bridge converts (src/worker/engines/kawari7.js).
('shiori_so/shiori.cpp',
r'''DLL_API int load(const char *datapath)
{
	return(Shiori_Load(datapath));
}''',
r'''#ifdef __EMSCRIPTEN__
DLL_API int load(char *datapath,long len)
{
	string path(datapath,(size_t)len);
	free(datapath);
	return(Shiori_Load(EmUtf8ToCp932(path)));
}
#else
DLL_API int load(const char *datapath)
{
	return(Shiori_Load(datapath));
}
#endif'''),
('shiori_so/shiori.cpp',
r'''DLL_API char *request(const char *requeststr)
{
	string aistr=Shiori_Request(requeststr);

	char *reth=(char*)malloc(aistr.size());
	memcpy(reth,aistr.c_str(),aistr.size());

	return(reth);
}''',
r'''#ifdef __EMSCRIPTEN__
DLL_API char *request(char *requeststr,long *len)
{
	string req(requeststr,(size_t)*len);
	free(requeststr);
	string aistr=Shiori_Request(req);

	char *reth=(char*)malloc(aistr.size()+1);
	memcpy(reth,aistr.data(),aistr.size());
	reth[aistr.size()]=0;
	*len=(long)aistr.size();

	return(reth);
}
#else
DLL_API char *request(const char *requeststr)
{
	string aistr=Shiori_Request(requeststr);

	char *reth=(char*)malloc(aistr.size());
	memcpy(reth,aistr.c_str(),aistr.size());

	return(reth);
}
#endif'''),
('shiori_so/shiori.h',
r'''int load(const char *datapath);''',
r'''#ifdef __EMSCRIPTEN__
int load(char *datapath,long len);
#else
int load(const char *datapath);
#endif'''),
('shiori_so/shiori.h',
r'''char *request(const char *requeststr);''',
r'''#ifdef __EMSCRIPTEN__
char *request(char *requeststr,long *len);
#else
char *request(const char *requeststr);
#endif'''),

# ---------------------------------------------------------------- C7. the resume snapshot's hooks
('libkawari/kawari.cpp',
r'''	Engine=new TKawariEngine(this);
}''',
r'''	Engine=new TKawariEngine(this);
#ifdef __EMSCRIPTEN__
	EmSetEngine(Engine);
#endif
}'''),
('libkawari/kawari.cpp',
r'''	string aistr=GetSentence("system.OnLoad");''',
r'''#ifdef __EMSCRIPTEN__
	EmBeforeOnLoad();		// the snapshot's baseline: what kawari.ini and the dictionaries define
#endif
	string aistr=GetSentence("system.OnLoad");
#ifdef __EMSCRIPTEN__
	EmAfterOnLoad();		// and the entries OnLoad left (one the session then cleared is cleared again)
#endif'''),
('libkawari/kawari_dict.h',
r'''public:

	~TNS_KawariDictionary (){''',
r'''public:
#ifdef __EMSCRIPTEN__
	// sumika (C7): the resume snapshot reads every entry's word ids and names
	const map<TEntryID,vector<TWordID> >& EmEntries(void) const { return(Dictionary); }
	string EmEntryName(TEntryID id) const { const string *s=EntryCollection.Find(id); return(s ? *s : string()); }
#endif

	~TNS_KawariDictionary (){'''),
('libkawari/kawari_engine.h',
r'''public:

	// \217\356\225\361\214\156API''',
r'''public:
#ifdef __EMSCRIPTEN__
	// sumika (C7): the resume snapshot
	TNS_KawariDictionary *EmDictionary(void) const { return(Dictionary); }
	bool EmProtected(TEntryID entry) const { return(ProtectedEntry.count(entry)!=0); }
#endif

	// \217\356\225\361\214\156API'''),

# ---------------------------------------------------------------- C9. one unload
# Shiori_Unload deletes the interface and leaves the pointer: a second unload (or a request after it) would use freed
# memory. ssp.exe never calls either; an in-process caller may (tools/sweep after a ghost's own \-): the pointer is
# cleared, so a second unload answers false and a request the build's own 500.
('shiori/shiori_interface.cpp',
r'''	bool status=ShioriInterface->Unload();

	delete ShioriInterface;
''',
r'''#ifdef __EMSCRIPTEN__
	if(!ShioriInterface) return(false);
#endif
	bool status=ShioriInterface->Unload();

	delete ShioriInterface;
#ifdef __EMSCRIPTEN__
	ShioriInterface=0;
#endif
'''),
]

EXTRA_EXPORTS = ['_kawari7_utf8_to_cp932', '_kawari7_cp932_to_utf8', '_kawari7_snapshot', '_kawari7_restore', '_kawari7_entries', '_kawari7_dump']
EXTRA_CFLAGS = []
