import { parseFragment } from 'parse5';
import { renderTex } from '../compile/markdown.ts';

// LaTeX in a plan's text as a Word equation (Office Math, OMML), through the MathML temml writes
// for the module: Word then shows and edits it as its own maths. The elements temml writes for the
// plan's subset are converted (letters, numbers, operators, text, fractions, roots, scripts, limits,
// accents, bars, matrices); anything else keeps its characters in a plain run.

type Node = { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };

const MATH_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
export { MATH_NS };

export function texToOmml(tex: string, display: boolean): string {
  const fragment = parseFragment(renderTex(tex, display)) as unknown as Node;
  const math = (fragment.childNodes ?? []).find((node) => node.nodeName === 'math');
  const body = math ? children(math) : run(tex, true);
  return display ? `<m:oMathPara><m:oMath>${body}</m:oMath></m:oMathPara>` : `<m:oMath>${body}</m:oMath>`;
}

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const elements = (node: Node): Node[] => (node.childNodes ?? []).filter((child) => child.tagName);
const attr = (node: Node, name: string): string | undefined => node.attrs?.find((entry) => entry.name === name)?.value;
const textOf = (node: Node): string => node.nodeName === '#text' ? node.value ?? '' : (node.childNodes ?? []).map(textOf).join('');
const children = (node: Node): string => elements(node).map(convert).join('');
const arg = (node: Node | undefined): string => (node ? convert(node) : '');

// A run: letters in maths italic (Word's default), or upright (plain).
function run(text: string, plain: boolean, normalText = false): string {
  if (!text) return '';
  const props = normalText ? '<m:rPr><m:nor/></m:rPr>' : plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : '';
  return `<m:r>${props}<m:t xml:space="preserve">${escape(text)}</m:t></m:r>`;
}

function convert(node: Node): string {
  const kids = elements(node);
  switch (node.tagName) {
    case 'mrow': case 'mstyle': case 'mpadded': case 'semantics': case 'math':
      return node.tagName === 'semantics' ? arg(kids[0]) : children(node);
    case 'mi': {
      const text = textOf(node);
      const upright = attr(node, 'mathvariant') === 'normal' || [...text].length > 1;
      return run(text, upright);
    }
    case 'mn': case 'mo': return run(textOf(node), true);
    case 'mtext': case 'ms': return run(textOf(node), true, true);
    case 'mspace': return run(' ', true);
    case 'mphantom': case 'annotation': case 'annotation-xml': return '';
    case 'msub': return `<m:sSub><m:e>${arg(kids[0])}</m:e><m:sub>${arg(kids[1])}</m:sub></m:sSub>`;
    case 'msup': return `<m:sSup><m:e>${arg(kids[0])}</m:e><m:sup>${arg(kids[1])}</m:sup></m:sSup>`;
    case 'msubsup': return `<m:sSubSup><m:e>${arg(kids[0])}</m:e><m:sub>${arg(kids[1])}</m:sub><m:sup>${arg(kids[2])}</m:sup></m:sSubSup>`;
    case 'mfrac': {
      const bar = attr(node, 'linethickness') === '0' || attr(node, 'linethickness') === '0px' ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : '';
      return `<m:f>${bar}<m:num>${arg(kids[0])}</m:num><m:den>${arg(kids[1])}</m:den></m:f>`;
    }
    case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${children(node)}</m:e></m:rad>`;
    case 'mroot': return `<m:rad><m:deg>${arg(kids[1])}</m:deg><m:e>${arg(kids[0])}</m:e></m:rad>`;
    case 'munder': return `<m:limLow><m:e>${arg(kids[0])}</m:e><m:lim>${arg(kids[1])}</m:lim></m:limLow>`;
    case 'mover': {
      const accent = kids[1] && kids[1].tagName === 'mo' ? textOf(kids[1]) : '';
      if (attr(node, 'accent') === 'true' && [...accent].length === 1) return `<m:acc><m:accPr><m:chr m:val="${escape(accent)}"/></m:accPr><m:e>${arg(kids[0])}</m:e></m:acc>`;
      return `<m:limUpp><m:e>${arg(kids[0])}</m:e><m:lim>${arg(kids[1])}</m:lim></m:limUpp>`;
    }
    case 'munderover': return `<m:limUpp><m:e><m:limLow><m:e>${arg(kids[0])}</m:e><m:lim>${arg(kids[1])}</m:lim></m:limLow></m:e><m:lim>${arg(kids[2])}</m:lim></m:limUpp>`;
    case 'menclose': {
      const notation = attr(node, 'notation') ?? '';
      if (/\btop\b/.test(notation)) return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${children(node)}</m:e></m:bar>`;
      if (/\bbottom\b/.test(notation)) return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${children(node)}</m:e></m:bar>`;
      return `<m:borderBox><m:e>${children(node)}</m:e></m:borderBox>`;
    }
    case 'mtable': return `<m:m>${kids.filter((row) => row.tagName === 'mtr' || row.tagName === 'mlabeledtr').map((row) => `<m:mr>${elements(row).map((cell) => `<m:e>${children(cell)}</m:e>`).join('')}</m:mr>`).join('')}</m:m>`;
    default: return kids.length ? children(node) : run(textOf(node), true);
  }
}
