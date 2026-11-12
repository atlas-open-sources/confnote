// A sample ending: the closing screens as segments, rendered after the storyboard's scenes. Copy it next to your
// storyboard and pass it with --ending. Each segment is a scene (any kind) plus an id, an optional enabled: false,
// and its narration as voice [[offset, block, text]] with block numbers of 90 and up. See README "Change the ending".

window.ENDING = {
  segments: [
    {
      id: 'hosted',
      kind: 'cards3',
      dur: 6,
      voice: [[0.3, 90, 'It runs in the browser: pay as you go, or bring your own key.']],
      kicker: 'confnote, your way',
      cards: [
        { label: 'In the browser', title: 'Pay as you go', items: ['AI credits through PayPal'] },
        { label: 'Your own key', title: 'BYOK', items: ['OpenAI or Anthropic'] },
        { label: 'On your Mac', title: 'Mac app', items: ['Your notes as plain files'] },
      ],
    },
    {
      id: 'promo',
      enabled: false,
      kind: 'statement',
      dur: 5,
      voice: [[0.3, 91, 'One line about the thing you are promoting.']],
      label: 'Also from us',
      title: 'Another app',
      lines: ['One line about it.'],
    },
    {
      id: 'music',
      kind: 'statement',
      dur: 5,
      voice: [[0.3, 92, 'Say what made the music.']],
      label: 'Music',
      title: 'The track title',
      lines: ['What made it, and where.'],
    },
    {
      id: 'close',
      kind: 'credits',
      dur: 4,
      brand: 'confnote',
      line: 'Notes for the conferences you go to.',
      footnote: 'recorded live on staging.confnote.si',
    },
  ],
};
