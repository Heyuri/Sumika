// SSP's character references, as ssp.exe 2.9.10 reads them (shiori-events.md §5.5). Pure.
//
// SPGetCharcodeReference [disasm 0x5e8dd0, sp_char.obj]: a case-sensitive wcscmp binary search over HTML 4's 252
// entity names (pointers at 0xbb0d1c, one UTF-16 code unit each at 0xbb110c); no numeric form (`#38`, `#x26`), no
// `apos`; a name it does not know gives a space (U+0020). Its two callers: SPGhost::DecodeEntity (below) and the
// script player's `\&[…]` (DecodeProcReal 0x6292c5, on ParseBracket's string as it is; player.js, SS §5.3).
//
// SPGhost::DecodeEntity [disasm 0x625b10] runs on every value SPShiori::GetStringShiori returns (menu captions and
// visibility, site lists, tooltips, username, version / name / craftman, `.ext.` properties) and nowhere else
// [disasm: its only caller, 0x713033]. Events, OnTranslate, \![embed] and TEACH replies are never decoded.

// name:code-unit pairs in the binary's order (sorted for the search)
const TABLE = `
AElig:198 Aacute:193 Acirc:194 Agrave:192 Alpha:913 Aring:197 Atilde:195 Auml:196 Beta:914 Ccedil:199 Chi:935
Dagger:8225 Delta:916 ETH:208 Eacute:201 Ecirc:202 Egrave:200 Epsilon:917 Eta:919 Euml:203 Gamma:915 Iacute:205
Icirc:206 Igrave:204 Iota:921 Iuml:207 Kappa:922 Lambda:923 Mu:924 Ntilde:209 Nu:925 OElig:338 Oacute:211 Ocirc:212
Ograve:210 Omega:937 Omicron:927 Oslash:216 Otilde:213 Ouml:214 Phi:934 Pi:928 Prime:8243 Psi:936 Rho:929 Scaron:352
Sigma:931 THORN:222 Tau:932 Theta:920 Uacute:218 Ucirc:219 Ugrave:217 Upsilon:933 Uuml:220 Xi:926 Yacute:221
Yuml:376 Zeta:918 aacute:225 acirc:226 acute:180 aelig:230 agrave:224 alefsym:8501 alpha:945 amp:38 and:8743
ang:8736 aring:229 asymp:8776 atilde:227 auml:228 bdquo:8222 beta:946 brvbar:166 bull:8226 cap:8745 ccedil:231
cedil:184 cent:162 chi:967 circ:710 clubs:9827 cong:8773 copy:169 crarr:8629 cup:8746 curren:164 dArr:8659
dagger:8224 darr:8595 deg:176 delta:948 diams:9830 divide:247 eacute:233 ecirc:234 egrave:232 empty:8709 emsp:8195
ensp:8194 epsilon:949 equiv:8801 eta:951 eth:240 euml:235 euro:8364 exist:8707 fnof:402 forall:8704 frac12:189
frac14:188 frac34:190 frasl:8260 gamma:947 ge:8805 gt:62 hArr:8660 harr:8596 hearts:9829 hellip:8230 iacute:237
icirc:238 iexcl:161 igrave:236 image:8465 infin:8734 int:8747 iota:953 iquest:191 isin:8712 iuml:239 kappa:954
lArr:8656 lambda:955 lang:9001 laquo:171 larr:8592 lceil:8968 ldquo:8220 le:8804 lfloor:8970 lowast:8727 loz:9674
lrm:8206 lsaquo:8249 lsquo:8216 lt:60 macr:175 mdash:8212 micro:181 middot:183 minus:8722 mu:956 nabla:8711 nbsp:160
ndash:8211 ne:8800 ni:8715 not:172 notin:8713 nsub:8836 ntilde:241 nu:957 oacute:243 ocirc:244 oelig:339 ograve:242
oline:8254 omega:969 omicron:959 oplus:8853 or:8744 ordf:170 ordm:186 oslash:248 otilde:245 otimes:8855 ouml:246
para:182 part:8706 permil:8240 perp:8869 phi:966 pi:960 piv:982 plusmn:177 pound:163 prime:8242 prod:8719 prop:8733
psi:968 quot:34 rArr:8658 radic:8730 rang:9002 raquo:187 rarr:8594 rceil:8969 rdquo:8221 real:8476 reg:174
rfloor:8971 rho:961 rlm:8207 rsaquo:8250 rsquo:8217 sbquo:8218 scaron:353 sdot:8901 sect:167 shy:173 sigma:963
sigmaf:962 sim:8764 spades:9824 sub:8834 sube:8838 sum:8721 sup:8835 sup1:185 sup2:178 sup3:179 supe:8839 szlig:223
tau:964 there4:8756 theta:952 thetasym:977 thinsp:8201 thorn:254 tilde:732 times:215 trade:8482 uArr:8657 uacute:250
uarr:8593 ucirc:251 ugrave:249 uml:168 upsih:978 upsilon:965 uuml:252 weierp:8472 xi:958 yacute:253 yen:165 yuml:255
zeta:950 zwj:8205 zwnj:8204
`;

/** name -> the character, SSP's 252 (a Map: `\&[constructor]` is no entity) */
export const CHARCODE_REFERENCES = new Map(TABLE.trim().split(/\s+/).map(p => {
  const k = p.indexOf(':');
  return [p.slice(0, k), String.fromCharCode(+p.slice(k + 1))];
}));

/** SPGetCharcodeReference: the character a name stands for; case-sensitive; unknown (numeric forms too) -> ' '. */
export function charcodeReference(name) {
  return CHARCODE_REFERENCES.get(String(name)) ?? ' ';
}

/**
 * SPGhost::DecodeEntity [disasm 0x625b10] on a GetStringShiori value, in UTF-16 code units as ssp.exe's JWString:
 * - the scan runs while 3 more characters follow (i + 3 < length); `\\` is skipped as a pair, so `\\&[amp]` stays;
 * - at `\&[` the name runs to the first `]` (nothing else stops it: `\&[a\&[amp]` is one name) or to the end of the
 *   string, which an unclosed one then takes with it (`x\&[amp` → `x&`);
 * - a name of 1–19 units is replaced, `\&[` … `]` and all, by charcodeReference(name) (unknown → a space), and the
 *   scan goes on after that character, so it is never read again; an empty or longer name stays, the scan moving one
 *   character on (an entity inside a long one is still found).
 * @param {string} s
 * @returns {string}
 */
export function decodeEntity(s) {
  s = String(s ?? '');
  if (!s.includes('\\&[')) return s;
  let out = '', from = 0, i = 0;
  while (i + 3 < s.length) {
    if (s[i] !== '\\') { i++; continue; }
    if (s[i + 1] === '\\') { i += 2; continue; }
    if (s[i + 1] === '&' && s[i + 2] === '[') {
      let j = i + 3;
      while (s[j] !== ']' && ++j < s.length);
      const name = s.slice(i + 3, j);
      if (name.length > 0 && name.length < 20) {
        out += s.slice(from, i) + charcodeReference(name);
        from = i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out + s.slice(from);
}
