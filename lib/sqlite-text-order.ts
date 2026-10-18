/** Compare SQLite UTF-8 BINARY text keys, rather than JavaScript UTF-16 units.
 * UTF-8 byte order equals Unicode scalar order; lone surrogate code units map
 * to U+FFFD just as TextEncoder and UTF-8 SQLite bindings do. No normalization,
 * case folding, locale collation or identifier rewriting is performed. */
export function compareSqliteText(left:string,right:string):number{
 let a=0,b=0;
 while(a<left.length&&b<right.length){
  const rawA=left.codePointAt(a)!,rawB=right.codePointAt(b)!;
  const scalarA=rawA>=0xd800&&rawA<=0xdfff?0xfffd:rawA,scalarB=rawB>=0xd800&&rawB<=0xdfff?0xfffd:rawB;
  if(scalarA!==scalarB)return scalarA<scalarB?-1:1;
  a+=rawA>0xffff?2:1;b+=rawB>0xffff?2:1;
 }
 return a<left.length?1:b<right.length?-1:0;
}
