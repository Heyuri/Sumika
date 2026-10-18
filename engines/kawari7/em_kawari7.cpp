//---------------------------------------------------------------------------
// sumika: the glue between KAWARI 7.5.0 and Sumika's worker (declarations and the text-mode stream in em_kawari7.h).
// Compiled as one more unit next to Kawari's (engines/kawari7/build.py). docs/research/kawari7-wasm.md.
//   code page 932 <-> UTF-8 (the shared Windows table) for the worker's SHIORI/2 bridge and the file names
//   the log sink: Module.kawariLog(line) (`debug: log` in kawari.ini)
//   the resume snapshot: kawari7_snapshot / kawari7_restore (the baseline is taken before system.OnLoad)
//---------------------------------------------------------------------------
#include "config.h"
#include "em_kawari7.h"
#include "misc/cp932_table.h"
#include "libkawari/kawari_engine.h"
#include <emscripten.h>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <string>
#include <vector>
#include <map>
#include <set>
using namespace std;
//---------------------------------------------------------------------------
// Code page 932 (engines/kawari/em_kawari.cpp's converter: ssp.exe encodes with WideCharToMultiByte(932, 0), best fit)
//---------------------------------------------------------------------------
#define EM_CP932_BEST_FIT 1
namespace {
int em_cp932_lead_index(unsigned char c)
{
	if ( c >= 0x81 && c <= 0x9F ) { return c - 0x81; }
	if ( c >= 0xE0 && c <= 0xFC ) { return c - 0xE0 + 31; }
	return -1;
}
void em_put_utf8(string& o, unsigned long u)
{
	if ( u < 0x80 ) { o += (char)u; }
	else if ( u < 0x800 ) { o += (char)(0xC0 | (u >> 6)); o += (char)(0x80 | (u & 0x3F)); }
	else if ( u < 0x10000 ) { o += (char)(0xE0 | (u >> 12)); o += (char)(0x80 | ((u >> 6) & 0x3F)); o += (char)(0x80 | (u & 0x3F)); }
	else { o += (char)(0xF0 | (u >> 18)); o += (char)(0x80 | ((u >> 12) & 0x3F)); o += (char)(0x80 | ((u >> 6) & 0x3F)); o += (char)(0x80 | (u & 0x3F)); }
}
unsigned short em_cp932_find(const unsigned short *ucs, const unsigned short *mb, unsigned int count, unsigned long c)
{
	unsigned int lo = 0, hi = count;
	while ( lo < hi ) {
		const unsigned int mid = (lo + hi) / 2;
		if ( ucs[mid] < c ) { lo = mid + 1; } else { hi = mid; }
	}
	return ( lo < count && ucs[lo] == c ) ? mb[lo] : 0;
}
}
string EmCp932ToUtf8(const string& str)
{
	string o;
	o.reserve(str.size() * 3 / 2);
	const unsigned char* p = reinterpret_cast<const unsigned char*>(str.data());
	const unsigned char* e = p + str.size();
	while ( p < e ) {
		const unsigned char c = *p++;
		if ( c < 0x80 ) { o += (char)c; continue; }
		const int li = em_cp932_lead_index(c);
		if ( li < 0 ) {
			const unsigned short u = cp932_single_hi[c - 0x80];
			em_put_utf8(o, u ? u : 0x30FB);
			continue;
		}
		if ( p >= e ) { em_put_utf8(o, 0x30FB); break; }
		const unsigned char t = *p++;
		const unsigned short u = ( t >= 0x40 && t <= 0xFC ) ? cp932_dbcs[li * 189 + (t - 0x40)] : 0;
		em_put_utf8(o, u ? u : 0x30FB);
	}
	return o;
}
string EmUtf8ToCp932(const string& str)
{
	string o;
	o.reserve(str.size());
	const unsigned char* p = reinterpret_cast<const unsigned char*>(str.data());
	const unsigned char* e = p + str.size();
	while ( p < e ) {
		unsigned long c = *p++;
		if ( c < 0x80 ) { o += (char)c; continue; }
		int n = (c >= 0xF0 && c <= 0xF4) ? 3 : (c >= 0xE0) && (c <= 0xEF) ? 2 : (c >= 0xC2 && c <= 0xDF) ? 1 : -1;
		if ( n < 0 ) { o += '?'; continue; }
		c &= (n == 1) ? 0x1F : (n == 2) ? 0x0F : 0x07;
		int k = 0;
		for ( ; k < n && p < e && (*p & 0xC0) == 0x80 ; ++k ) { c = (c << 6) | (*p++ & 0x3F); }
		if ( k < n ) { o += '?'; continue; }
		if ( c > 0xFFFF ) { o += "??"; continue; }
		unsigned short mb = em_cp932_find(cp932_enc_ucs, cp932_enc_mb, cp932_enc_count, c);
#if EM_CP932_BEST_FIT
		if ( !mb ) { mb = em_cp932_find(cp932_bf_ucs, cp932_bf_mb, cp932_bf_count, c); }
#endif
		if ( mb ) {
			if ( mb > 0xFF ) { o += (char)(mb >> 8); }
			o += (char)(mb & 0xFF);
		} else {
			o += '?';
		}
	}
	return o;
}
namespace {
bool em_header_line(const string& msg, string::size_type b, string::size_type e, const char* name)
{
	const string::size_type n = strlen(name);
	if ( e - b <= n || msg[b + n] != ':' ) return false;
	for ( string::size_type i = 0 ; i < n ; ++i ) {
		if ( tolower((unsigned char)msg[b + i]) != tolower((unsigned char)name[i]) ) return false;
	}
	return true;
}
}
string EmHeader(const string& msg, const char* name)
{
	string::size_type b = msg.find('\n');
	while ( b != string::npos ) {
		++b;
		string::size_type e = msg.find('\n', b);
		if ( e == string::npos ) e = msg.size();
		string::size_type le = (e > b && msg[e - 1] == '\r') ? e - 1 : e;
		if ( le == b ) break;
		if ( em_header_line(msg, b, le, name) ) {
			string::size_type v = b + strlen(name) + 1;
			while ( v < le && msg[v] == ' ' ) ++v;
			return msg.substr(v, le - v);
		}
		b = (e < msg.size()) ? e : string::npos;
	}
	return "";
}
string EmSetHeader(const string& msg, const char* name, const char* value)
{
	string::size_type b = msg.find('\n');
	while ( b != string::npos ) {
		++b;
		string::size_type e = msg.find('\n', b);
		if ( e == string::npos ) e = msg.size();
		string::size_type le = (e > b && msg[e - 1] == '\r') ? e - 1 : e;
		if ( le == b ) break;
		if ( em_header_line(msg, b, le, name) ) {
			return msg.substr(0, b) + name + ": " + value + msg.substr(le);
		}
		b = (e < msg.size()) ? e : string::npos;
	}
	return msg;
}
//---------------------------------------------------------------------------
// SAORI (patch C3)
//---------------------------------------------------------------------------
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
struct em_saori_lib { int handle; unsigned int count; };
map<string, em_saori_lib> em_saori_libs;
// the DLL's path as MEMFS names it ('\' as '/', UTF-8), and its key: case-insensitive on single bytes (NTFS)
string em_saori_path(const string &file)
{
	string p=EmFsPath(file);
	for (string::size_type i=0; i<p.size(); i++) if (p[i]=='\\') p[i]='/';
	return p;
}
string em_saori_key(const string &path)
{
	string k=path;
	for (string::size_type i=0; i<k.size(); i++) if ((unsigned char)k[i]<0x80) k[i]=(char)tolower((unsigned char)k[i]);
	return k;
}
}
bool TSaoriBindingEm::Load(const string &file)
{
	const string path=em_saori_path(file);
	key=em_saori_key(path);
	map<string, em_saori_lib>::iterator it=em_saori_libs.find(key);
	if (it!=em_saori_libs.end()){
		it->second.count++;
		handle=it->second.handle;
		return true;
	}
	const string::size_type pos=path.rfind('/');
	const string dir=(pos==string::npos) ? string("") : path.substr(0, pos+1);
	const int h=js_saori_load(path.c_str(), dir.c_str());
	if (h<=0) return false;
	em_saori_lib lib={ h, 1 };
	em_saori_libs[key]=lib;
	handle=h;
	return true;
}
TSaoriBindingEm::~TSaoriBindingEm()
{
	map<string, em_saori_lib>::iterator it=em_saori_libs.find(key);
	if ((it==em_saori_libs.end())||(it->second.handle!=handle)) return;
	if ((--it->second.count)==0){
		em_saori_libs.erase(it);
		js_saori_unload(handle);
	}
}
unsigned int TSaoriBindingEm::GetLoadCount(void)
{
	map<string, em_saori_lib>::iterator it=em_saori_libs.find(key);
	return ((it!=em_saori_libs.end())&&(it->second.handle==handle)) ? it->second.count : 0;
}
string TSaoriBindingEm::Request(const string &req)
{
	// Kawari asks in Shift_JIS (code page 932); the stand-ins speak UTF-8 (the bridge's contract)
	string cs=EmHeader(req, "Charset");
	for (string::size_type i=0; i<cs.size(); i++) cs[i]=(char)tolower((unsigned char)cs[i]);
	const bool sjis=(cs=="shift_jis")||(cs=="sjis")||(cs=="x-sjis")||(cs=="cp932")||(cs=="windows-31j")||(cs=="");
	string r=sjis ? EmSetHeader(EmCp932ToUtf8(req), "Charset", "UTF-8") : req;
	int out_len=0;
	char *p=js_saori_request(handle, r.data(), (int)r.size(), &out_len);
	string res(p, out_len);
	free(p);
	string rcs=EmHeader(res, "Charset");
	for (string::size_type i=0; i<rcs.size(); i++) rcs[i]=(char)tolower((unsigned char)rcs[i]);
	if (sjis&&((rcs=="utf-8")||(rcs=="utf8")))
		res=EmSetHeader(EmUtf8ToCp932(res), "Charset", "Shift_JIS");
	return res;
}
//---------------------------------------------------------------------------
// The log sink
//---------------------------------------------------------------------------
EM_JS(int, js_kawari7_log_on, (void), {
	return (typeof Module['kawariLog'] === 'function') ? 1 : 0;
});
EM_JS(void, js_kawari7_log, (const char* text), {
	try { Module['kawariLog'](UTF8ToString(text)); } catch (e) {}
});
namespace {
class EmLogBuf : public std::streambuf {
	string line;
protected:
	virtual int_type overflow(int_type c){
		if (traits_type::eq_int_type(c, traits_type::eof())) return traits_type::not_eof(c);
		if (traits_type::to_char_type(c)=='\n'){ flushline(); } else { line+=traits_type::to_char_type(c); }
		return c;
	}
	virtual int sync(){ return 0; }
	void flushline(){
		if (line.size()&&line[line.size()-1]=='\r') line.erase(line.size()-1);
		js_kawari7_log(EmCp932ToUtf8(line).c_str());
		line.clear();
	}
};
ostream *em_log_stream=NULL;
}
ostream *EmLogStream(void)
{
	if (!js_kawari7_log_on()) return NULL;
	if (!em_log_stream) em_log_stream=new ostream(new EmLogBuf());
	return em_log_stream;
}
//---------------------------------------------------------------------------
// Paths and text-mode reads (patch C4)
//---------------------------------------------------------------------------
string EmFsPath(const string& p)
{
	string u=EmCp932ToUtf8(p);
	for (string::size_type i=0; i<u.size(); i++) if (u[i]=='\\') u[i]='/';
	return u;
}
void EmTextIfstream::open(const char *path)
{
	opened=false;
	buf.str(string());
	FILE *fp=fopen(EmFsPath(path ? path : "").c_str(), "rb");
	if (!fp){ setstate(std::ios::failbit); return; }
	string raw;
	char chunk[8192];
	size_t n;
	while ((n=fread(chunk, 1, sizeof(chunk), fp))>0) raw.append(chunk, n);
	fclose(fp);
	string text;
	text.reserve(raw.size());
	for (string::size_type i=0; i<raw.size(); i++){
		const char c=raw[i];
		if (c=='\x1A') break;
		if ((c=='\r')&&(i+1<raw.size())&&(raw[i+1]=='\n')) continue;
		text+=c;
	}
	buf.str(text);
	clear();
	opened=true;
}
//---------------------------------------------------------------------------
// The resume snapshot (patch C7; docs/research/kawari7-wasm.md section 8)
//
// The baseline is every entry's word ids once kawari.ini and the dictionaries are read, before system.OnLoad runs.
// kawari7_snapshot(path) writes each entry whose word ids differ from it: what OnLoad made and what the session changed
// (the next page's load reads the same definitions and runs OnLoad again; restoring these on top gives back the
// session's own values, a boot count or a random pick OnLoad made included). Word ids are never reused in Kawari 7
// (TWordCollection only grows), so equal id lists are equal words. Left out: the entries every request rewrites
// (system.Reference0-7, Sender, Sender.Path, Age, Sentence, Surface, EventName, ID; the communicate replies
// system.Response0-7, system.communicate, system.BalloonOffset) and write-protected entries (they refuse writes).
// The file, code page 932 bytes, one record per line, fields escaped (\\ \n \r):
//   K7SNAP 1                header
//   C NAME                  NAME is empty now: cleared
//   E NAME                  NAME holds the W lines that follow (cleared first)
//   W WORD                  a word as SaveKawariDict writes it (DisCompile), inserted with the engine's Insert
//---------------------------------------------------------------------------
namespace {
TKawariEngine *em_engine=NULL;
map<TEntryID, vector<TWordID> > em_baseline;
set<TEntryID> em_onload;		// the entries present after OnLoad
bool em_have_baseline=false;
const char *const EM_REQUEST_ENTRIES[]={ "system.Sender", "system.Sender.Path", "system.Age", "system.Sentence",
	"system.Surface", "system.EventName", "system.ID", "system.communicate", "system.BalloonOffset", NULL };
bool em_left_out(const string &name)
{
	for (int i=0; i<=7; i++){
		const char d=(char)('0'+i);
		if ((name.size()==17)&&(name.compare(0, 16, "system.Reference")==0)&&(name[16]==d)) return true;
		if ((name.size()==16)&&(name.compare(0, 15, "system.Response")==0)&&(name[15]==d)) return true;
	}
	for (int i=0; EM_REQUEST_ENTRIES[i]; i++) if (name==EM_REQUEST_ENTRIES[i]) return true;
	return false;
}
string em_escape(const string &s)
{
	string o;
	o.reserve(s.size());
	for (string::size_type i=0; i<s.size(); i++){
		const char c=s[i];
		if (c=='\\') o+="\\\\"; else if (c=='\n') o+="\\n"; else if (c=='\r') o+="\\r"; else o+=c;
	}
	return o;
}
string em_unescape(const string &s)
{
	string o;
	o.reserve(s.size());
	for (string::size_type i=0; i<s.size(); i++){
		if ((s[i]=='\\')&&(i+1<s.size())){
			const char c=s[++i];
			o+=(c=='n') ? '\n' : (c=='r') ? '\r' : c;
		} else {
			o+=s[i];
		}
	}
	return o;
}
}
void EmSetEngine(TKawariEngine *engine)
{
	em_engine=engine;
	em_baseline.clear();
	em_onload.clear();
	em_have_baseline=false;
}
void EmBeforeOnLoad(void)
{
	if (!em_engine) return;
	em_baseline=em_engine->EmDictionary()->EmEntries();
	em_have_baseline=true;
}
void EmAfterOnLoad(void)
{
	if (!em_engine||!em_have_baseline) return;
	const map<TEntryID, vector<TWordID> > &now=em_engine->EmDictionary()->EmEntries();
	for (map<TEntryID, vector<TWordID> >::const_iterator it=now.begin(); it!=now.end(); it++) em_onload.insert(it->first);
}
void EmClearEngine(TKawariEngine *engine)
{
	if (em_engine==engine) EmSetEngine(NULL);
}
// the number of entries after the last load's system.OnLoad (the adapter's debug line); 0 before a load
extern "C" EMSCRIPTEN_KEEPALIVE int kawari7_entries(void)
{
	return (int)em_onload.size();
}
// write the entries that differ from the baseline to `path` (UTF-8, MEMFS). The file is always rewritten; nothing to
// carry = an empty file. Returns its size in bytes (0 = nothing), -1 without a loaded engine or when it cannot be
// written.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari7_snapshot(const char *path)
{
	if (!em_engine||!em_have_baseline||!path) return -1;
	try {
		TNS_KawariDictionary *dict=em_engine->EmDictionary();
		const map<TEntryID, vector<TWordID> > &now=dict->EmEntries();
		string out;
		map<TEntryID, vector<TWordID> >::const_iterator b=em_baseline.begin(), n=now.begin();
		while ((b!=em_baseline.end())||(n!=now.end())){
			TEntryID id;
			const vector<TWordID> *words=NULL;
			bool changed;
			if ((n==now.end())||((b!=em_baseline.end())&&(b->first<n->first))){
				id=b->first; changed=true; b++;					// cleared since
			} else if ((b==em_baseline.end())||(n->first<b->first)){
				id=n->first; words=&n->second; changed=true; n++;	// new since
			} else {
				id=n->first; words=&n->second; changed=(b->second!=n->second); b++; n++;
			}
			if (!changed||em_engine->EmProtected(id)) continue;
			const string name=dict->EmEntryName(id);
			if (name.empty()||em_left_out(name)) continue;
			if (!words||words->empty()){
				out+="C "+em_escape(name)+"\n";
				continue;
			}
			out+="E "+em_escape(name)+"\n";
			for (vector<TWordID>::const_iterator w=words->begin(); w!=words->end(); w++){
				TKawariCode_base *code=dict->GetWordFromID(*w);
				out+="W "+em_escape(code ? code->DisCompile() : string())+"\n";
			}
		}
		// entries OnLoad made that the session emptied: the next load's OnLoad would make them again
		for (set<TEntryID>::const_iterator it=em_onload.begin(); it!=em_onload.end(); it++){
			if (now.count(*it)||em_baseline.count(*it)||em_engine->EmProtected(*it)) continue;
			const string name=dict->EmEntryName(*it);
			if (name.size()&&!em_left_out(name)) out+="C "+em_escape(name)+"\n";
		}
		if (out.size()) out="K7SNAP 1\n"+out;
		FILE *fp=fopen(path, "wb");
		if (!fp) return -1;
		const size_t k=out.size() ? fwrite(out.data(), 1, out.size(), fp) : 0;
		fclose(fp);
		return (k==out.size()) ? (int)k : -1;
	} catch (...) {
		return -1;
	}
}
// every entry of the running engine with its words, in the snapshot's format (tools/sweep's resume check compares two
// engines by it); write-protected and left-out entries skipped as in a snapshot. Returns its size, -1 without a loaded
// engine or when it cannot be written.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari7_dump(const char *path)
{
	if (!em_engine||!path) return -1;
	try {
		TNS_KawariDictionary *dict=em_engine->EmDictionary();
		const map<TEntryID, vector<TWordID> > &now=dict->EmEntries();
		string out="K7SNAP 1\n";
		for (map<TEntryID, vector<TWordID> >::const_iterator n=now.begin(); n!=now.end(); n++){
			if (n->second.empty()||em_engine->EmProtected(n->first)) continue;
			const string name=dict->EmEntryName(n->first);
			if (name.empty()||em_left_out(name)) continue;
			out+="E "+em_escape(name)+"\n";
			for (vector<TWordID>::const_iterator w=n->second.begin(); w!=n->second.end(); w++){
				TKawariCode_base *code=dict->GetWordFromID(*w);
				out+="W "+em_escape(code ? code->DisCompile() : string())+"\n";
			}
		}
		FILE *fp=fopen(path, "wb");
		if (!fp) return -1;
		const size_t k=fwrite(out.data(), 1, out.size(), fp);
		fclose(fp);
		return (k==out.size()) ? (int)k : -1;
	} catch (...) {
		return -1;
	}
}
// load a snapshot into the running engine (after the page's load): each entry is cleared, then given its words back.
// Returns 1, or 0 without a loaded engine or a readable snapshot.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari7_restore(const char *path)
{
	if (!em_engine||!path) return 0;
	try {
		FILE *fp=fopen(path, "rb");
		if (!fp) return 0;
		string data;
		char chunk[8192];
		size_t k;
		while ((k=fread(chunk, 1, sizeof(chunk), fp))>0) data.append(chunk, k);
		fclose(fp);
		// leading '#' lines are the page's (the adapter's `# dicStamp` line)
		string::size_type pos=0;
		while ((pos<data.size())&&(data[pos]=='#')){
			const string::size_type e=data.find('\n', pos);
			pos=(e==string::npos) ? data.size() : e+1;
		}
		if (pos>=data.size()) return 1;
		if (data.compare(pos, 9, "K7SNAP 1\n")!=0) return 0;
		string entry;
		pos+=9;
		while (pos<data.size()){
			string::size_type e=data.find('\n', pos);
			if (e==string::npos) e=data.size();
			const string line=data.substr(pos, e-pos);
			pos=e+1;
			if (line.size()<2) continue;
			const string value=em_unescape(line.substr(2));
			if (line[0]=='C'){ em_engine->ClearEntry(value); entry.clear(); }
			else if (line[0]=='E'){ entry=value; em_engine->ClearEntry(entry); }
			else if ((line[0]=='W')&&entry.size()){ em_engine->Insert(entry, value); }
		}
		return 1;
	} catch (...) {
		return 0;
	}
}
//---------------------------------------------------------------------------
// Conversions for the worker: a malloc'd buffer of *outlen bytes plus a NUL that the caller frees
//---------------------------------------------------------------------------
namespace {
char *em_out(const string &r, int *outlen)
{
	char *p=(char *)malloc(r.size()+1);
	if (!p) return NULL;
	memcpy(p, r.data(), r.size());
	p[r.size()]=0;
	if (outlen) *outlen=(int)r.size();
	return p;
}
}
extern "C" EMSCRIPTEN_KEEPALIVE char *kawari7_utf8_to_cp932(const char *s, int len, int *outlen)
{
	return em_out((s&&(len>0)) ? EmUtf8ToCp932(string(s, (size_t)len)) : string(), outlen);
}
extern "C" EMSCRIPTEN_KEEPALIVE char *kawari7_cp932_to_utf8(const char *s, int len, int *outlen)
{
	return em_out((s&&(len>0)) ? EmCp932ToUtf8(string(s, (size_t)len)) : string(), outlen);
}
//---------------------------------------------------------------------------
