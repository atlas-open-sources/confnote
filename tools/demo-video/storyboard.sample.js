// A sample storyboard: copy it next to your takes, edit, and render with motion/render.py.
// Footage times are seconds in a take (source `a` = the frames that `render.py frames --src a=…` extracted).
// Zoom rects are the top-left of the visible area in source pixels plus a zoom factor (1 shows a 1920x936
// band; ALL shows the whole frame). Narration lines live in `voice`; scenes cue them with vo [[offset, block]].

const LIVE = '#4ad17e'; // the app's --live: the only colour, for functional status

// The venue for the `map` scene: a point and its building's footprint (from OpenStreetMap; here IET London,
// 2 Savoy Place, OSM way 98479924).
const VENUE = [-0.11924, 51.51003];
const VENUE_FOOTPRINT = [
  [-0.118856, 51.509974],
  [-0.119396, 51.509804],
  [-0.119618, 51.510083],
  [-0.119446, 51.510137],
  [-0.119168, 51.510227],
  [-0.119208, 51.510275],
  [-0.119109, 51.510305],
  [-0.118856, 51.509974],
];

window.STORY = {
  fps: 30,
  srcFps: 25,
  appUrl: 'staging.confnote.si',
  chapters: {
    1: { title: 'Import a conference', sub: 'Paste the agenda link into the Concierge' },
    2: { title: 'Take notes', sub: 'One note per session' },
  },
  voice: {
    1: 'This is a conference I went to.',
    2: 'I paste its agenda link into the Concierge, and the whole day is set up.',
    3: 'Each session gets its own note.',
    4: 'confnote. Notes for the conferences you go to.',
  },
  scenes: [
    // ---- The opening (v7): hook, fly-in, the venue, the hall, the origin in pencil. Asset paths are relative to
    // tools/demo-video/assets/ (credits in assets/LICENCES.md).
    {
      kind: 'hook',
      dur: 2.6,
      words: [
        [0.08, 'One conference.'],
        [0.82, 'One hour.'],
        [1.56, 'confnote', { brand: true }],
      ],
      outAt: 2.15,
    },
    {
      kind: 'map',
      dur: 4.2,
      path: [
        [0.0, [-0.105, 51.5075], 11.2, 0, 0], // wide London
        [1.0, [-0.087, 51.5072], 13.4, 42, -72], // down onto the Thames, heading west
        [2.1, [-0.103, 51.5086], 14.9, 58, -80],
        [3.1, [-0.115, 51.5092], 16.3, 64, -52],
        [4.0, [-0.11935, 51.51012], 17.5, 66, -28], // onto Savoy Place
      ],
      venue: { lngLat: VENUE, footprint: VENUE_FOOTPRINT, height: 32, at: 2.9, title: 'IET London', sub: '2 Savoy Place · WC2R 0BL' },
    },
    {
      kind: 'photo',
      dur: 1.9,
      src: 'photos/iet-savoy-place-shadowssettle-2020.jpg',
      credit: 'Photo: Shadowssettle, CC BY-SA 4.0',
      label: { title: 'A conference', sub: 'London · 19 May 2026' },
      fore: [[0, 0.85], [0.5, 0.8], [1, 0.85], [1, 1.05], [0, 1.05]], // trace the real foreground for real depth
    },
    {
      kind: 'three',
      rig: 'hall',
      dur: 2.4,
      screen: { kicker: 'Welcome', title: 'A conference', sub: 'London · 19 May 2026' },
    },
    {
      kind: 'pencil',
      dur: 5.0,
      speed: 5,
      lines: [
        [0.45, 'A conference', 'under'],
        [1.8, 'first version within the hour'],
        [3.9, 'used it all day'],
      ],
    },
    {
      kind: 'three',
      rig: 'desk',
      dur: 3.2,
      title: 'confnote',
      sub: 'Notes for the conferences you go to',
      titleAt: 1.4,
      cardsAt: 0.4,
      cards: [
        { label: 'Module', title: 'tldraw' },
        { label: 'Module', title: 'Bryntum' },
        { label: 'Module', title: 'AG Grid' },
      ],
    },
    {
      kind: 'cards',
      dur: 6,
      vo: [[0.5, 1]],
      kicker: 'Where it started',
      cards: [
        { label: '19 May 2026 · London', title: 'A conference', body: 'One day, eighteen talks', meta: '18 sessions · 15 speakers' },
      ],
      cardAt: [0.5],
    },
    {
      kind: 'code',
      dur: 5,
      kicker: 'Where it started',
      url: 'example.com/agenda.json',
      badge: 'live',
      lines: [
        ['p', '{'],
        ['kv', '  "name": ', '"A conference",'],
        ['kv', '  "date": ', '"2026-05-19"'],
        ['p', '}'],
      ],
    },
    { kind: 'chapter', n: 1, dur: 2.4 },
    {
      kind: 'footage',
      chapter: 1,
      src: 'a',
      parts: [[10.0, 16.0, 2.0], [16.0, 22.0, 1.0]],
      vo: [[0.3, 2]],
      caption: 'The Concierge imports the agenda from its link',
      zooms: [[0, { x: 0, y: 0, z: 936 / 1080 }], [3.0, { x: 0, y: 0, z: 936 / 1080 }], [4.0, { x: 720, y: 495, z: 1.6 }]],
      callouts: [[4.5, 7.5, LIVE, 'Conference imported', '18 sessions, one note each']],
    },
    { kind: 'chapter', n: 2, dur: 2.4 },
    { kind: 'placeholder', dur: 6, vo: [[0.3, 3]], lines: ['Notes · a session note being typed'] },
    {
      kind: 'cards3',
      dur: 7,
      kicker: 'confnote, your way',
      cards: [
        { label: 'In the browser', title: 'Pay as you go', items: ['Credits through PayPal'] },
        { label: 'Your own key', title: 'Your provider', items: ['OpenAI or Anthropic'] },
        { label: 'On your Mac', title: 'Mac app', items: ['Coming soon'] },
      ],
      proof: 'Recorded on staging · <code>PayPal sandbox</code>',
      button: 'staging.confnote.si',
    },
    {
      kind: 'credits',
      dur: 6,
      vo: [[0.3, 4]],
      brand: 'confnote',
      tag: 'Music',
      line: 'Credit the music here, with <b>what made it</b>.',
      // The map and the venue photo need their credits on screen (assets/LICENCES.md lists every line).
      footnote: 'Map: OpenFreeMap © OpenMapTiles Data from OpenStreetMap · Photo: Shadowssettle, CC BY-SA 4.0',
    },
  ],
};
