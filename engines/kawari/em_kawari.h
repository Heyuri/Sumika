//---------------------------------------------------------------------------
// sumika: the glue between KAWARI 8.2.8 and Sumika's worker (engines/kawari/em_kawari.cpp). Not part of Kawari; the
// build copies it next to the sources and misc/l10n.h includes it under __EMSCRIPTEN__ (patch K4), so every patched
// file sees it. Plan: scratch kawari/plan.md section 1.3 (K4, K8, K9, K11, K12).
//---------------------------------------------------------------------------
#ifndef EM_KAWARI_H
#define EM_KAWARI_H
#ifdef __EMSCRIPTEN__
//---------------------------------------------------------------------------
#include <string>
#include <ostream>
#include <streambuf>
#include <fstream>
#include <cstring>
//---------------------------------------------------------------------------
// K4: code page 932 <-> UTF-8 as Windows converts it (engines/common/gen_cp932.py's table, measured on Windows):
// decode = MultiByteToWideChar(932, 0) (an invalid pair is one U+30FB), encode = WideCharToMultiByte(932, 0) as
// ssp.exe calls it (best fit: e -> 'e'; '?' for anything else, "??" for a character outside the BMP: a surrogate pair)
std::string EmCp932ToUtf8(const std::string& s);
std::string EmUtf8ToCp932(const std::string& s);
// a path as Kawari holds it (code page 932, what the Windows ANSI file API takes) -> as MEMFS names it (UTF-8) (K6)
inline std::string EmFsPath(const std::string& p) { return EmCp932ToUtf8(p); }
// the header value of `name` in a SHIORI/SAORI message (header lines only, name case-insensitive); "" when absent
std::string EmHeader(const std::string& msg, const char* name);
// the message with the value of header `name` replaced (only when the header is there)
std::string EmSetHeader(const std::string& msg, const char* name, const char* value);
//---------------------------------------------------------------------------
// K8, K9: Kawari's log, line by line to Module.kawariLog(text) in UTF-8
// the level to start with (Module.kawariLogLevel, default error|warning); -1 when the page set no Module.kawariLog
int EmLogLevel(void);
// the stream that feeds Module.kawariLog; NULL when the page set none (the logger then writes nowhere)
std::ostream *EmLogStream(void);
//---------------------------------------------------------------------------
// K11: an ofstream in Windows text mode: every '\n' written reaches the file as "\r\n", as the DLL's ofstream (opened
// without ios::binary) writes it. open / is_open / close as std::ofstream's.
class EmTextFileBuf : public std::streambuf {
	std::filebuf file;
protected:
	virtual int_type overflow(int_type c){
		if (traits_type::eq_int_type(c, traits_type::eof())) return traits_type::not_eof(c);
		if ((traits_type::to_char_type(c)=='\n')&&traits_type::eq_int_type(file.sputc('\r'), traits_type::eof()))
			return traits_type::eof();
		return file.sputc(traits_type::to_char_type(c));
	}
	virtual std::streamsize xsputn(const char *s, std::streamsize n){
		std::streamsize done=0;
		while (done<n){
			const char *nl=(const char *)memchr(s+done, '\n', (size_t)(n-done));
			const std::streamsize len=nl ? (std::streamsize)(nl-(s+done)) : n-done;
			if (len&&(file.sputn(s+done, len)!=len)) return done;
			done+=len;
			if (nl){
				if (file.sputn("\r\n", 2)!=2) return done;
				done++;
			}
		}
		return done;
	}
	virtual int sync(){ return file.pubsync(); }
public:
	bool open(const char *path, std::ios_base::openmode mode){
		return file.open(path, mode|std::ios_base::out|std::ios_base::binary)!=NULL;
	}
	bool is_open(void) const { return file.is_open(); }
	bool close(void){ return file.close()!=NULL; }
};
class EmTextOfstream : public std::ostream {
	EmTextFileBuf buf;
public:
	EmTextOfstream() : std::ostream(NULL) { rdbuf(&buf); }
	void open(const char *path, std::ios_base::openmode mode=std::ios_base::out){
		if (buf.open(path, mode)) clear(); else setstate(std::ios_base::failbit);
	}
	bool is_open(void) const { return buf.is_open(); }
	void close(void){ if (!buf.close()) setstate(std::ios_base::failbit); }
};
//---------------------------------------------------------------------------
// K12: the resume snapshot (exports kawari_baseline / kawari_snapshot / kawari_restore in em_kawari.cpp)
class TKawariEngine;
// TKawariShioriAdapter::Load hands its engine over; Unload and the destructor take it back
void EmSetEngine(TKawariEngine *engine);
void EmClearEngine(TKawariEngine *engine);
// the dictionary's garbage collector freed this word id (TNS_KawariDictionary::DeleteContext); a freed id is handed
// out again to the next new word, so an entry that holds it again holds another word
void EmWordCollected(unsigned int id);
// a dictionary definition (`name : word`, TKawariEngine::LoadKawariDict's dictionary mode) pushed word `id` into
// `entry` during a load. An entry load left with other words than its definitions (a KIS zone or OnLoad wrote it: the
// clock, a random pick, a file read) is load-made, and every snapshot carries it
class TEntry;
void EmDefined(const TEntry &entry, unsigned int id);
// KIS's `function NAME body` (kawari_code.cpp) cleared `entry` (System.Function.NAME) and pushed `id`: its definition is
// that one word (the body is the zone's own text, the same on every load)
void EmDefinedOnly(const TEntry &entry, unsigned int id);
//---------------------------------------------------------------------------
#endif // __EMSCRIPTEN__
#endif // EM_KAWARI_H
