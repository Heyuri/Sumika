//---------------------------------------------------------------------------
// sumika: the glue between KAWARI 8.2.8 and Sumika's worker (declarations and the K11 stream in em_kawari.h).
// Compiled as one more unit next to Kawari's 40 (engines/kawari/build.py). Plan: scratch kawari/plan.md sections 1.2,
// 1.3 and 2.7.
//   K4   code page 932 <-> UTF-8 (the shared Windows table) and the SHIORI/SAORI header helpers
//   K8   the log sink: Module.kawariLog(line), level Module.kawariLogLevel (K9 points `logfile` at it too)
//   K12  the resume snapshot: kawari_baseline / kawari_snapshot / kawari_restore
//        and kawari_utf8_to_cp932 (the other ghosts' descript.txt in the SSP view, kawari-wasm.md section 6)
//---------------------------------------------------------------------------
#include "config.h"
#include "em_kawari.h"
#include "misc/l10n.h"
#include "misc/misc.h"
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
// K4. Code page 932
//---------------------------------------------------------------------------
// R1 (kawari-wasm.md section 3): ssp.exe encodes every request to a SHIORI that answers
// "Charset: Shift_JIS" with WideCharToMultiByte(932, 0, ..., NULL, NULL), code page 932 by name and flags 0, so best
// fit is on ('?' by default, "??" above the BMP); its internal SAORIs encode their replies the same way. 1 adds the
// table's 85 best-fit encodings after the WC_NO_BEST_FIT_CHARS ones (yaya.dll's flags too: e -> 'e'); 0 would be
// satori.dll's. [decision] one encoder for every UTF-8 -> 932 edge, the descript writer included.
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
// the byte sequence of code point c in a sorted table, 0 when absent
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
		// a lead byte takes the next byte whatever it is; an invalid pair, or a lead byte at the end, is one U+30FB
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
		if ( n < 0 ) { o += '?'; continue; }				// not a lead byte: U+FFFD, which code page 932 lacks
		c &= (n == 1) ? 0x1F : (n == 2) ? 0x0F : 0x07;
		int k = 0;
		for ( ; k < n && p < e && (*p & 0xC0) == 0x80 ; ++k ) { c = (c << 6) | (*p++ & 0x3F); }
		if ( k < n ) { o += '?'; continue; }
		if ( c > 0xFFFF ) { o += "??"; continue; }			// a surrogate pair in UTF-16: two '?'
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
		if ( le == b ) break;						// the blank line ends the headers
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
// K8. The log sink (Kawari's own log is a null stream at level 0 [src libkawari/kawari_log.cpp])
//---------------------------------------------------------------------------
EM_JS(int, js_kawari_log_level, (void), {
	if (typeof Module['kawariLog'] !== 'function') return -1;
	var l = Module['kawariLogLevel'];
	return (typeof l === 'number') ? (l | 0) : 3;
});
EM_JS(void, js_kawari_log, (const char* text), {
	try { Module['kawariLog'](UTF8ToString(text)); } catch (e) {}
});
namespace {
// one call per line, CP932 -> UTF-8, without the line end
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
		js_kawari_log(EmCp932ToUtf8(line).c_str());
		line.clear();
	}
};
ostream *em_log_stream=NULL;
}
int EmLogLevel(void)
{
	return js_kawari_log_level();
}
ostream *EmLogStream(void)
{
	if (js_kawari_log_level()<0) return NULL;
	if (!em_log_stream) em_log_stream=new ostream(new EmLogBuf());
	return em_log_stream;
}
//---------------------------------------------------------------------------
// K12. The resume snapshot (kawari-wasm.md section 8)
//
// kawari_baseline() after a load records each entry's word ids. kawari_snapshot(path, 0) writes the entries whose words
// differ from it; restore() on the next page (after that page's load and baseline) clears them and loads their words
// back. Words are written in `save`'s own format (GetWordFromID: the decompiled word, what ghosts save and reload
// themselves). The file (LF line ends, code page 932 bytes like every dictionary):
//   # clear NAME            every entry written, and every entry the session emptied: cleared before the load
//   # move N NAME           NAME is no EntryID (`set` takes any name): its words load into System.Sumika.Snapshot.N
//                           and move to NAME after the load
//   NAME : word , word      the dictionary lines (comment lines are skipped by Kawari's preprocessor)
// Left out: System.Request*, System.Response* (every request rewrites them) and write-protected entries (they refuse
// writes). A word id the garbage collector freed is handed out again (TWordCollection's Recycle), so an entry whose id
// list equals the baseline but holds a freed id counts as changed (EmWordCollected).
// Load-made entries: the next page's load sets an entry again, and an entry a KIS zone or System.Callback.OnLoad
// wrote may come out otherwise there (KEEPS' cntwork = the minute of the load, honue090104's Wearmode = a random
// pick), while SSP's one load keeps the first value all session. So every snapshot also carries each entry that load
// left with other words than the definitions it read (a dictionary line, EmDefined; KIS's `function NAME body`,
// EmDefinedOnly: the body is the zone's own text), changed or not, and clears each defined entry load emptied; the
// definitions come back the same from every load and stay out (a function body also costs much to load back as a
// dictionary line: asri101's 39 KB of them took 17 s).
//---------------------------------------------------------------------------
namespace {
TKawariEngine *em_engine=NULL;
struct EmBaseEntry {
	TEntry entry;
	vector<TWordID> words;
	bool loadmade;		// load left other words than its definitions: carried in every snapshot
	EmBaseEntry(const TEntry &e) : entry(e), loadmade(false) {}
};
// sorted by entry id: FindAllEntry walks the namespace's map<TEntryID, ...> in order
vector<EmBaseEntry> em_baseline;
bool em_have_baseline=false;
// word ids freed since the baseline
vector<unsigned char> em_collected;
// during a load (until the baseline): each entry's definitions in order, and the word ids freed meanwhile (a freed
// definition word's id may come back as another word)
vector<EmBaseEntry> em_defs;
map<TEntryID, size_t> em_def_index;
vector<unsigned char> em_load_collected;
// defined entries load emptied (a script cleared them): cleared again by every snapshot while they stay empty
vector<TEntry> em_load_cleared;
const char *const EM_TEMP_ENTRY="System.Sumika.Snapshot.";

bool em_left_out(const string &name)
{
	return (name.compare(0, 14, "System.Request")==0)||(name.compare(0, 15, "System.Response")==0)||
		(name.compare(0, 23, EM_TEMP_ENTRY)==0);
}
// a name the dictionary syntax reads back: EntryID ::= ( [0-9A-Za-z._?@] | NAChar ) + (kawari_lexer.cpp's id_map;
// every byte 0x80-0xFF is 1 there, and a lead byte takes any trail byte, as getLiteral)
bool em_entry_id(const string &name)
{
	if (name.empty()) return false;
	for (string::size_type i=0; i<name.size(); i++){
		const unsigned char c=(unsigned char)name[i];
		if (iskanji1st((char)c)){
			if (++i>=name.size()) return false;
		}else if ((c<0x80)&&!isalnum(c)&&(c!='.')&&(c!='_')&&(c!='?')&&(c!='@')){
			return false;
		}
	}
	return true;
}
bool em_writable(const string &name)
{
	return name.size()&&(name.find_first_of(string("\r\n\0", 3))==string::npos);
}
bool em_freed(const vector<unsigned char> &freed, const vector<TWordID> &words)
{
	for (vector<TWordID>::const_iterator it=words.begin(); it!=words.end(); it++)
		if ((*it<freed.size())&&freed[*it]) return true;
	return false;
}
bool em_touched(const vector<TWordID> &words)
{
	return em_freed(em_collected, words);
}
void em_forget_load(void)
{
	em_defs.clear();
	em_def_index.clear();
	em_load_collected.clear();
}
string em_word_list(const vector<TWordID> &words)
{
	string s;
	for (vector<TWordID>::const_iterator it=words.begin(); it!=words.end(); it++){
		if (it!=words.begin()) s+=" , ";
		s+=em_engine->GetWordFromID(*it);
	}
	return s;
}
bool em_read_file(const char *path, string &data)
{
	FILE *fp=fopen(path, "rb");
	if (!fp) return false;
	char buf[8192];
	size_t n;
	while ((n=fread(buf, 1, sizeof(buf), fp))>0) data.append(buf, n);
	fclose(fp);
	return true;
}
}
void EmSetEngine(TKawariEngine *engine)
{
	em_engine=engine;
	em_baseline.clear();
	em_collected.clear();
	em_load_cleared.clear();
	em_forget_load();
	em_have_baseline=false;
}
void EmClearEngine(TKawariEngine *engine)
{
	if (em_engine==engine) EmSetEngine(NULL);
}
void EmWordCollected(unsigned int id)
{
	vector<unsigned char> &freed=em_have_baseline ? em_collected : em_load_collected;
	if (id>=freed.size()) freed.resize(id+1, 0);
	freed[id]=1;
}
void EmDefined(const TEntry &entry, unsigned int id)
{
	if (!em_engine||em_have_baseline) return;		// a `load` after the baseline is the session's
	// an id freed earlier in the load and handed out again: it names this new word now (only a free after this
	// definition makes the entry load-made)
	if (id<em_load_collected.size()) em_load_collected[id]=0;
	map<TEntryID, size_t>::iterator f=em_def_index.find(entry.GetID());
	if (f==em_def_index.end()){
		f=em_def_index.insert(make_pair(entry.GetID(), em_defs.size())).first;
		em_defs.push_back(EmBaseEntry(entry));
	}
	em_defs[f->second].words.push_back(id);
}
void EmDefinedOnly(const TEntry &entry, unsigned int id)
{
	if (!em_engine||em_have_baseline) return;
	map<TEntryID, size_t>::iterator f=em_def_index.find(entry.GetID());
	if (f!=em_def_index.end()) em_defs[f->second].words.clear();
	EmDefined(entry, id);
}
// after a load: record every entry's word ids, and which entries load made (see above). Returns the number of
// entries, -1 without a loaded engine.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari_baseline(void)
{
	em_baseline.clear();
	em_collected.clear();
	em_load_cleared.clear();
	em_have_baseline=false;
	if (!em_engine) return -1;
	try {
		vector<TEntry> entries;
		em_engine->FindAllEntry(entries);
		em_baseline.reserve(entries.size());
		set<TEntryID> present;
		for (vector<TEntry>::iterator it=entries.begin(); it!=entries.end(); it++){
			em_baseline.push_back(EmBaseEntry(*it));
			EmBaseEntry &b=em_baseline.back();
			it->FindAll(b.words);
			present.insert(it->GetID());
			map<TEntryID, size_t>::const_iterator f=em_def_index.find(it->GetID());
			b.loadmade=(f==em_def_index.end())||(em_defs[f->second].words!=b.words)||
				em_freed(em_load_collected, b.words);
		}
		for (vector<EmBaseEntry>::const_iterator d=em_defs.begin(); d!=em_defs.end(); d++)
			if (!present.count(d->entry.GetID())) em_load_cleared.push_back(d->entry);
		em_forget_load();
		em_have_baseline=true;
		return (int)em_baseline.size();
	} catch (...) {
		em_baseline.clear();
		em_load_cleared.clear();
		em_forget_load();
		return -1;
	}
}
// write the entries that differ from the baseline, and the load-made ones, to `path` (UTF-8, MEMFS); all != 0: every
// entry (the sweep's resume check), as if each had changed. The file is always rewritten; nothing to carry = an empty
// file. Returns its size in bytes (0 = nothing to carry), -1 without a loaded engine or when the file cannot be
// written.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari_snapshot(const char *path, int all)
{
	if (!em_engine||!path) return -1;
	try {
		string clears, moves, lines;
		unsigned int temp=0;
		vector<TEntry> entries;
		em_engine->FindAllEntry(entries);
		vector<EmBaseEntry>::const_iterator base=em_baseline.begin();
		vector<TWordID> words;
		for (vector<TEntry>::iterator it=entries.begin(); ; it++){
			const TEntryID id=(it!=entries.end()) ? it->GetID() : 0;
			// baseline entries the walk passed are empty now: cleared by this session
			for (; (base!=em_baseline.end())&&((it==entries.end())||(base->entry.GetID()<id)); base++){
				const string name=base->entry.GetName();
				if (all||em_left_out(name)||base->entry.IsWriteProtected()||!em_writable(name)) continue;
				clears+="# clear "+name+"\n";
			}
			if (it==entries.end()) break;
			words.clear();
			it->FindAll(words);
			const bool known=(base!=em_baseline.end())&&(base->entry.GetID()==id);
			const bool same=known&&!base->loadmade&&(base->words==words)&&!em_touched(words);
			if (known) base++;
			if (same&&!all) continue;
			const string name=it->GetName();
			if (em_left_out(name)||it->IsWriteProtected()||!em_writable(name)) continue;
			clears+="# clear "+name+"\n";
			if (em_entry_id(name)){
				lines+=name+" : "+em_word_list(words)+"\n";
			}else{
				const string n=IntToString(++temp);
				moves+="# move "+n+" "+name+"\n";
				lines+=EM_TEMP_ENTRY+n+" : "+em_word_list(words)+"\n";
			}
		}
		// defined entries load emptied that are still empty: the next load fills them from their definitions again
		if (!all)
			for (vector<TEntry>::iterator it=em_load_cleared.begin(); it!=em_load_cleared.end(); it++){
				if (it->Size()) continue;		// filled since: written above
				const string name=it->GetName();
				if (em_left_out(name)||it->IsWriteProtected()||!em_writable(name)) continue;
				clears+="# clear "+name+"\n";
			}
		string text;
		if (clears.size())
			text="#\n# Sumika resume snapshot: the entries this session changed and those its load made "
				"(engines/kawari/em_kawari.cpp)\n#\n"+clears+moves+lines;
		FILE *fp=fopen(path, "wb");
		if (!fp) return -1;
		const size_t n=text.size() ? fwrite(text.data(), 1, text.size(), fp) : 0;
		fclose(fp);
		return (n==text.size()) ? (int)n : -1;
	} catch (...) {
		return -1;
	}
}
// load a snapshot into the running engine (after the page's load and baseline): its entries are cleared, then their
// words loaded. Returns 1, or 0 without a loaded engine or a readable file.
extern "C" EMSCRIPTEN_KEEPALIVE int kawari_restore(const char *path)
{
	if (!em_engine||!path) return 0;
	try {
		string data;
		if (!em_read_file(path, data)) return 0;
		vector<string> clears;
		vector<pair<string, string> > moves;
		string::size_type b=0;
		while (b<data.size()){
			string::size_type e=data.find('\n', b);
			if (e==string::npos) e=data.size();
			string line=data.substr(b, e-b);
			b=e+1;
			if (line.size()&&(line[line.size()-1]=='\r')) line.erase(line.size()-1);
			if (line.compare(0, 8, "# clear ")==0){
				clears.push_back(line.substr(8));
			}else if (line.compare(0, 7, "# move ")==0){
				const string::size_type sp=line.find(' ', 7);
				if (sp!=string::npos) moves.push_back(make_pair(EM_TEMP_ENTRY+line.substr(7, sp-7), line.substr(sp+1)));
			}
		}
		for (vector<string>::iterator it=clears.begin(); it!=clears.end(); it++){
			TEntry entry=em_engine->GetEntry(*it);
			if (entry.IsValid()&&!entry.IsWriteProtected()) entry.Clear();
		}
		if (data.size()) em_engine->LoadKawariDict(EmUtf8ToCp932(path));
		for (vector<pair<string, string> >::iterator it=moves.begin(); it!=moves.end(); it++){
			TEntry src=em_engine->GetEntry(it->first);
			if (!src.IsValid()) continue;
			vector<TWordID> ids;
			src.FindAll(ids);
			TEntry dst=em_engine->CreateEntry(it->second);
			if (dst.IsValid()&&!dst.IsWriteProtected())
				for (vector<TWordID>::iterator w=ids.begin(); w!=ids.end(); w++) dst.Push(*w);
			src.Clear();
		}
		return 1;
	} catch (...) {
		return 0;
	}
}
// UTF-8 -> code page 932 with the table above, for text the worker writes for Kawari to read (the other ghosts'
// descript.txt). Returns a malloc'd buffer (the caller frees it) of *outlen bytes plus a NUL.
extern "C" EMSCRIPTEN_KEEPALIVE char *kawari_utf8_to_cp932(const char *s, int len, int *outlen)
{
	const string r=(s&&(len>0)) ? EmUtf8ToCp932(string(s, (size_t)len)) : string();
	char *p=(char *)malloc(r.size()+1);
	if (!p) return NULL;
	memcpy(p, r.data(), r.size());
	p[r.size()]=0;
	if (outlen) *outlen=(int)r.size();
	return p;
}
//---------------------------------------------------------------------------
