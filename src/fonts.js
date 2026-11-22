// Applies the web-font stylesheet without blocking first paint.
//
// index.html loads it with media="print": the browser fetches it but does not wait
// for it before rendering. Once it has arrived, it is switched to media="all", and
// text swaps from the fallback font (the stylesheet uses font-display: swap).
//
// This is the classic `onload="this.media='all'"` pattern, moved into a same-origin
// file so the Content-Security-Policy can forbid inline event handlers.
const link = document.getElementById('webfonts');
if (link) {
    const apply = () => { link.media = 'all'; };
    if (link.sheet) apply();
    else link.addEventListener('load', apply, { once: true });
}
