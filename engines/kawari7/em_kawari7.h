//---------------------------------------------------------------------------
// sumika: the glue between KAWARI 7.5.0 and Sumika's worker (engines/kawari7/em_kawari7.cpp). Not part of Kawari; the
// build copies it next to the sources and config.h includes it under __EMSCRIPTEN__ (patch C1), so every file sees it.
// docs/research/kawari7-wasm.md.
//---------------------------------------------------------------------------
#ifndef EM_KAWARI7_H
#define EM_KAWARI7_H
#ifdef __EMSCRIPTEN__
//---------------------------------------------------------------------------
#include <string>
#include <ostream>
#include <streambuf>
#include <fstream>
#include <istream>
#include <sstream>
#include <cstring>
//---------------------------------------------------------------------------
// Code page 932 <-> UTF-8 as Windows converts it (engines/common/gen_cp932.py's table, measured on Windows): decode =
// MultiByteToWideChar(932, 0) (an invalid pair is one U+30FB), encode = WideCharToMultiByte(932, 0) as ssp.exe calls
// it (best fit; '?' for anything else, "??" for a character outside the BMP)
std::string EmCp932ToUtf8(const std::string& s);
std::string EmUtf8ToCp932(const std::string& s);
// a path as Kawari holds it (code page 932, what the Windows ANSI file API takes, '\' or '/' between folders) -> as
// MEMFS names it (UTF-8, '/'); converted first, so a 0x5C trail byte is never taken for a separator
std::string EmFsPath(const std::string& p);
//---------------------------------------------------------------------------
// Kawari's log (`debug: log` in kawari.ini, which opened kawari.log): line by line to Module.kawariLog(text) in
// UTF-8; NULL when the page set no Module.kawariLog (no file is ever made)
std::ostream *EmLogStream(void);
//---------------------------------------------------------------------------
// The DLL's file streams (patch C4), msvcrt's text mode (opened without ios::binary). Both take Kawari's own path (code
// page 932, EmFsPath). open / is_open / close as std::ifstream's and std::ofstream's.
// Writing: every '\n' reaches the file as "\r\n".
class EmTextFileBuf : public std::streambuf {
	std::filebuf file;
protected:
	virtual int_type overflow(int_type c){
		if (traits_type::eq_int_type(c, traits_type::eof())) return traits_type::not_eof(c);
		if (traits_type::to_char_type(c)=='\n'){
			if (traits_type::eq_int_type(file.sputc('\r'), traits_type::eof())) return traits_type::eof();
		}
		return file.sputc(traits_type::to_char_type(c));
	}
	virtual int sync(){ return file.pubsync(); }
public:
	bool open(const std::string &path){ return file.open(path.c_str(), std::ios::out|std::ios::binary|std::ios::trunc)!=0; }
	bool is_open() const { return file.is_open(); }
	void close(){ file.close(); }
};
class EmTextOfstream : public std::ostream {
	EmTextFileBuf buf;
public:
	EmTextOfstream() : std::ostream(&buf) {}
	void open(const char *path){ if (!buf.open(EmFsPath(path))) setstate(std::ios::failbit); else clear(); }
	bool is_open() const { return buf.is_open(); }
	void close(){ buf.close(); }
};
// Reading: the whole file at open, "\r\n" read as "\n" (a lone '\r' stays), and a Ctrl+Z (0x1A) ends it, as msvcrt's
// text-mode read [infer: the C runtime's documented text mode]. Shift_JIS never has 0x0D, 0x0A or 0x1A as a trail byte.
class EmTextIfstream : public std::istream {
	std::stringbuf buf;
	bool opened;
public:
	EmTextIfstream() : std::istream(&buf), opened(false) {}
	void open(const char *path);
	bool is_open() const { return opened; }
	void close(){ opened=false; buf.str(std::string()); }
};
//---------------------------------------------------------------------------
// the header value of `name` in a SHIORI/SAORI message (header lines only, name case-insensitive); "" when absent
std::string EmHeader(const std::string& msg, const char* name);
// the message with the value of header `name` replaced (only when the header is there)
std::string EmSetHeader(const std::string& msg, const char* name, const char* value);
//---------------------------------------------------------------------------
// SAORI (patch C3): saori.cpp's TSaoriBinding, TSaoriBindingW32's interface over Module.saoriBridge (the Kawari 8
// build's contract: load(path, dir) -> handle > 0, request(handle, bytes) -> string | bytes in UTF-8, unload(handle)).
// LoadLibrary hands out one module per DLL, counted: one bridge handle per path (case-insensitive on single bytes), its
// load at the first Bind, its unload when the last binding goes. Requests are converted 932 <-> UTF-8 at this edge.
class TSaoriBindingEm {
	int handle;
	std::string key;
	TSaoriBindingEm() : handle(0) {}
	bool Load(const std::string &path);
public:
	static TSaoriBindingEm *Bind(const std::string &path){
		TSaoriBindingEm *bind=new TSaoriBindingEm();
		if (bind->Load(path)) return bind;
		delete bind;
		return NULL;
	}
	std::string Request(const std::string &request);
	unsigned int GetLoadCount(void);
	~TSaoriBindingEm();
};
//---------------------------------------------------------------------------
// the resume snapshot's hooks (patch C7): the engine TNS_KawariANI made, the baseline once kawari.ini and the
// dictionaries are read (before system.OnLoad), and the engine going
void EmSetEngine(class TKawariEngine *engine);
void EmBeforeOnLoad(void);
void EmAfterOnLoad(void);
void EmClearEngine(class TKawariEngine *engine);
//---------------------------------------------------------------------------
#endif
#endif
