/** Chinese prose commonly puts quoted emphasis directly beside surrounding text. */
export function createMarkdownParser(marked) {
  const parser=new marked.Marked();
  parser.use({extensions:[{
    name:'cjkQuotedStrong',level:'inline',
    start(src){const at=src.indexOf('**');return at<0?undefined:at;},
    tokenizer(src){
      if(this.lexer.state.inRawBlock)return false;
      if(!src.startsWith('**')||src.startsWith('***'))return false;
      // Only exact, unescaped pairs on the same line; leave other emphasis to Marked.
      for(let at=2;at<src.length-1;at++){
        if(src[at]==='\n'||src[at]==='\r')return false;
        if(src[at]==='\\'){at++;continue;}
        if(src[at]==='`'){
          let size=1;while(src[at+size]==='`')size++;
          const close=src.indexOf('`'.repeat(size),at+size);
          if(close!==-1 && !/[\r\n]/.test(src.slice(at,close))){at=close+size-1;continue;}
          at+=size-1;continue;
        }
        if(src.slice(at,at+2)!=='**')continue;
        if(src[at+2]==='*')return false;
        const text=src.slice(2,at);
        if(!text||/^\s|\s$/.test(text))return false;
        const chinese=/[\p{Script=Han}“”‘’「」『』《》]/u.test(text);
        const punctEdge=/^\p{P}|\p{P}$/u.test(text);
        if(!chinese||!punctEdge)return false;
        return {type:'cjkQuotedStrong',raw:src.slice(0,at+2),text,tokens:this.lexer.inlineTokens(text)};
      }
      return false;
    },
    renderer(token){return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;},
  }]});
  return parser;
}
