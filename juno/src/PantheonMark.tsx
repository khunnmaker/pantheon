// The shared Pantheon crest — a classical temple facade (pediment, four columns, stylobate):
// literally "the house of all the gods". Fills with `currentColor`, so the caller sets size and
// colour via className (e.g. `w-8 h-8 text-white` inside the violet badge). Kept byte-identical
// across every app so all login screens carry one consistent suite mark.
export default function PantheonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="currentColor" role="img" aria-label="The Pantheon">
      <path d="M5 21 L24 8 L43 21 Z" />
      <rect x="8" y="22.5" width="32" height="3.5" rx="1" />
      <rect x="11" y="28" width="4" height="12.5" />
      <rect x="18.7" y="28" width="4" height="12.5" />
      <rect x="25.3" y="28" width="4" height="12.5" />
      <rect x="33" y="28" width="4" height="12.5" />
      <rect x="7" y="40.5" width="34" height="4" rx="1.5" />
    </svg>
  );
}
