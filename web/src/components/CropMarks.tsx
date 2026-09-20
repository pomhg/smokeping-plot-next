/** Registration-mark corners, purely decorative. Parent needs position: relative. */
export function CropMarks() {
  return (
    <span className="crop" aria-hidden="true">
      <i className="tl" />
      <i className="tr" />
      <i className="bl" />
      <i className="br" />
    </span>
  );
}
