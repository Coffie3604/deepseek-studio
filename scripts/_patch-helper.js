'use strict';
/* One-off patch helper: splice a replacement between two unique anchors. */
const fs = require('fs');

function splice(file, startAnchor, endAnchor, replacement, label) {
    const s = fs.readFileSync(file, 'utf8');
    const a = s.indexOf(startAnchor);
    const b = s.indexOf(endAnchor);
    if (a === -1 || b === -1 || b <= a) throw new Error(label + ': anchors not found');
    fs.writeFileSync(file, s.slice(0, a) + replacement + s.slice(b));
    console.log('patched', label);
}

module.exports = { splice };
