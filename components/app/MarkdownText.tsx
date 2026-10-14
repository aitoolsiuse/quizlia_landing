import { parseMarkdownBlocks, parseMarkdownInline } from "@/lib/markdown";

interface MarkdownTextProps {
  text: string;
  className?: string;
}

// Renders the Quizlia text subset (see lib/markdown.ts). Pass the text
// styling through className exactly as the old plain <p> had it.
export function MarkdownText({ text, className }: MarkdownTextProps) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === "ul" || block.kind === "ol") {
          const Tag = block.kind === "ul" ? "ul" : "ol";
          const markerClass = block.kind === "ul" ? "list-disc" : "list-decimal";
          return (
            <Tag key={blockIndex} className={`${markerClass} pl-5 my-2 space-y-1`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={blockIndex} className="my-2 first:mt-0 last:mb-0">
            {block.kind === "paragraph" &&
              block.lines.map((line, lineIndex) => (
                <span key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  {renderInline(line)}
                </span>
              ))}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  return parseMarkdownInline(text).map((segment, index) => {
    if (segment.strong) return <strong key={index}>{segment.text}</strong>;
    if (segment.em) return <em key={index}>{segment.text}</em>;
    return <span key={index}>{segment.text}</span>;
  });
}
