/**
 * The behaviour engine. It lives on the bottom edge of the viewport and roams all of it. Nothing is scripted
 * in order: every turn it picks one of ~45 acts, strongly preferring the ones it has done least (the tally is
 * kept in localStorage, so each start begins with something new). It walks with real acceleration and
 * footsteps that match the ground covered, its eyes follow the cursor, and it can be poked, picked up and thrown.
 *
 * - All motion is handed to the browser as animations (Web Animations API on the dock's `translate` / `rotate` /
 *   `scale`, committed to inline style when they finish), so the GPU moves him and no script runs per frame.
 *   A walk (`go`) is worked out ahead — speed, footsteps, lean — and played back the same way. Only being
 *   dragged, thrown, and the ball are stepped frame by frame.
 * - Poses are CSS classes on the art box; each limb is its own little layer (see art.ts).
 * - Page elements are animated with composite "add" so their own transforms are kept. If the page scrolls
 *   mid-trick, the element springs back and the bot drops.
 *
 * `startEngine` runs until the returned function is called. Stopping and starting again keeps its spot.
 */

import type { Gear } from "./art";

type Pt = [number, number, number?];

export type EngineCtx = {
  el: HTMLDivElement;
  /** The pose box: carries the pose class and the walk-cycle CSS variables. */
  svg: HTMLElement;
  hit: HTMLDivElement;
  host: HTMLElement;
  setPose: (p: string) => void;
  setLeft: (l: boolean) => void;
  setGear: (g: Gear) => void;
  getGear: () => Gear;
  /** Selector of page elements it may climb and tug, or "" for none. */
  targets: string;
  scroller: HTMLElement | null;
  page: HTMLElement | null;
  avoid: string;
  themeToggle: string;
  storageKey: string;
  fps: number;
  trackPointer: boolean;
  greet: boolean;
  /** Shared with the host so the pointer can be fed from outside (e.g. a desktop overlay). `wake` is set by the engine: call it after feeding a new position. */
  mouse: { x: number; y: number; t: number; wake?: () => void };
  onInteractive: (on: boolean) => void;
  onAct: (name: string) => void;
  /** His character, set by the host and read live (see Traits). */
  traits: Traits;
  /** Called when his energy, mood or fullness changes noticeably (all 0…1). */
  onMood: (m: { energy: number; mood: number; full: number }) => void;
  /** Food from the host: `drop` is set by the engine and throws one snack onto the floor. */
  pantry: { drop?: () => void };
  /** The desktop around him, fed by the host (see WorldBlock). `changed` is set by the engine. */
  world: { blocks: WorldBlock[] | null; changed?: () => void };
  /** What is going on around him, fed by the host (see Sense). `on` is set by the engine; `state` outlives it. */
  senses: Senses;
  /** Called with true when he stands on a window (watch it closely so he can ride along) and false when he leaves. */
  onPerch: (on: boolean) => void;
  /** Called once with the play() function and the list of acts. */
  expose: (play: (name?: string) => string[]) => void;
};
/**
 * Something on a desktop he can climb, in page px. kind 0: a window (the list goes front to back, z is the
 * place in it), 1: a desktop icon, 2: the Dock (a step along the bottom of the screen), 3: a ledge — the top edge
 * of anything drawn on screen (an input box, a menu, a panel), `on` being the window it is drawn in (0: none).
 */
/**
 * Something happening on the computer, from the host. `c` is the kind of app ("chat", "browser", "code", "ai",
 * "music", "files", "notes", "mail", "video", "design", "settings", "other"); rectangles are in page px.
 */
export type Sense =
  | { t: "app"; c: string; id?: number; x?: number; y?: number; w?: number; h?: number } // another app came to the front
  | { t: "apps"; a: Record<string, string> } // the kind of app each window (by id) belongs to
  | { t: "window"; c: string; id: number; x: number; y: number; w: number; h: number } // a new window opened
  | { t: "music"; on: boolean } // a music player started or stopped
  | { t: "notify"; x: number; y: number; w: number; h: number } // a notification banner showed up
  | { t: "power"; plugged: boolean; level: number } // charger and battery
  | { t: "shot" } // a screenshot is being taken
  | { t: "away"; on: boolean } // the person left the computer (no input for a while) or came back
  | { t: "typing"; on: boolean } // the person has been typing for a while, or stopped
  | { t: "copy" } // something was copied (only that it happened, never what)
  | { t: "theme"; dark: boolean } // dark mode switched on or off
  | { t: "net"; on: boolean } // the internet went away or came back
  | { t: "quit"; c: string; name: string } // an app was closed
  | { t: "launch"; c: string; name: string } // an app was opened
  | { t: "space" } // switched to another desktop (Space)
  | { t: "download" }; // a download finished
/**
 * His character. activity: 0.5 calm … 1 normal … 1.8 hyper (how much he runs, flies and climbs, and how long he
 * rests between things). chatty: 0 quiet … 1 normal … 2 chatterbox. The rest switch habits on or off.
 */
export type Traits = { activity: number; chatty: number; breaks: boolean; nightSleep: boolean; follow: boolean };
export type Senses = {
  state: { apps: Record<string, string>; music: boolean; away: boolean; plugged: boolean | null; low: boolean; typing: boolean };
  on?: (e: Sense) => void;
};
export type WorldBlock = { id: number; kind: number; x: number; y: number; w: number; h: number; z: number; on?: number };
type Act = { w: number; kind?: "top" | "bottom"; fit?: (r: DOMRect) => boolean; ok?: () => boolean; run: (t: HTMLElement) => Promise<void> };
type GoOpts = { speed?: number; pose?: string; face?: boolean; back?: boolean; roll?: number };

const SPEED = 46; // px per second strolling
const RUN = 150; // px per second running
const GRAVITY = 2600; // px per second squared when thrown
const GEARS: Gear[] = ["shades", "tophat", "bow", "crown", "cap", "phones", "none"];

const STICKERS = [
  '<path d="M15 3 l3.5 7.5 8 1 -6 5.5 1.6 8 -7.1 -4 -7.1 4 1.6 -8 -6 -5.5 8 -1 Z"/>',
  '<path d="M15 26 C6 19 3 14 5 9 c2 -5 8 -5 10 0 c2 -5 8 -5 10 0 c2 5 -1 10 -10 17 Z"/>',
  '<path d="M17 3 L7 17 h7 l-2 10 L23 12 h-7 Z"/>',
  '<circle cx="15" cy="15" r="11"/><path d="M10 17 q5 5 10 0" style="fill:none"/><path d="M11 11 v1 M19 11 v1"/>',
  '<path d="M6 16 l6 6 L25 8" style="fill:none"/>',
  '<path d="M15 4 v22 M4 15 h22 M7 7 l16 16 M23 7 L7 23" style="fill:none"/>',
  '<path d="M5 22 C5 10 12 6 15 6 s10 4 10 16 Z"/><path d="M11 15 v1 M19 15 v1"/>',
];

type Phrases = Record<string, string[]>;
/** Everything he says, in English. Keys starting with "app_" are about a kind of app; "{name}" is filled in. */
const EN: Phrases = {
  hi: ["hi!", "hey!", "yo!", "o/", "sup"],
  oops: ["oops", "ow!", "oof", "whoa"],
  yay: ["yay!", "ta-da!", "nice!", "woo!", "easy"],
  fly: ["wheee!", "whoosh", "zoom!", "bye!"],
  hmm: ["hmm…", "?", "huh"],
  poke: ["hey!", "eep!", "that tickles", "boop"],
  thrown: ["waaah!", "aaaa!", "not again!", "wheee!"],
  song: ["♪ ♫", "la la ♪", "♫"],
  strain: ["hnnng", "grrr", "nnngh"],
  look: ["new look", "fancy", "✦"],
  top: ["made it!", "view's nice", "hi up here", "ta-da!"],
  ride: ["whoa!", "wheee!", "hey!", "careful!"],
  peek: ["boo!", "peekaboo", "found me?"],
  laugh: ["haha", "hehe", "lol"],
  sneeze: ["achoo!"],
  boo: ["boo!"],
  hehe: ["hehe"],
  gotcha: ["gotcha!", "got it!"],
  fixed: ["fixed!", "all better"],
  phew: ["phew", "made it"],
  pet: ["♥", "hehe ♥", "more pats!", "purr…", "best day ever"],
  annoyed: ["stop it!", "hey, I'm busy!", "grr", "rude!"],
  app_chat: ["who're you texting? 👀", "say hi from me!", "I want an emoji too", "don't forget to reply", "ooh, gossip?"],
  app_browser: ["what are we looking for?", "open the memes", "so many tabs…", "I love the internet", "google me"],
  app_code: ["bugs again?", "you got this!", "did the tests pass?", "{ ✦ }", "commit often", "pretty code"],
  app_ai: ["hi, Claude!", "oh, a colleague!", "ask it about me", "we're friends here"],
  app_music: ["♪ louder!", "my song!", "♫ ♪", "DJ!"],
  app_files: ["tidying up?", "so many folders!", "cozy in here", "where's my file?"],
  app_notes: ["what are you writing?", "write about me", "nice handwriting", "genius idea"],
  app_mail: ["mail!", "reply later", "spam again?", "📮"],
  app_video: ["what are we watching?", "got popcorn?", "I'll watch too"],
  app_design: ["beautiful", "a bit to the left…", "I like it", "✦ stylish"],
  app_settings: ["don't break anything", "careful in there", "you won't turn me off, right?"],
  app_other: ["what's this?", "interesting…", "oh, hi", "can I look?"],
  newwin: ["oh, a new window!", "what's that?", "ooh!", "and this?"],
  music: ["♪ music!", "my jam!", "♫ ♪ ♫", "let's dance!"],
  ding: ["ding! 🔔", "someone's texting!", "a notification!", "who's there?", "mail's here?"],
  charge: ["⚡ yummy!", "mmm, energy", "charging up!", "⚡⚡⚡"],
  unplug: ["hey, give it back!", "what about me?", "oh, the cable"],
  tired: ["I need a recharge…", "battery's low", "so tired…"],
  missed: ["oops!", "oh no, my snack!", "too slow 😅", "hey, come back!"],
  hungry: ["I'm hungry… 🍪", "got any snacks?", "my tummy is rumbling", "is it lunchtime?"],
  stuffed: ["I'm stuffed! 🫃", "no more, I'm full", "can't eat another bite", "maybe later…"],
  cheese: ["cheese! 📸", "I'm photogenic", "take another!", "my good side"],
  sleepy: ["you left?", "nap time then", "so quiet…"],
  zzz: ["zzz", "z z z", "zZz"],
  welcome: ["you're back!", "welcome back!", "I wasn't sleeping, honest", "missed you!"],
  late: ["it's late… 🌙", "bedtime", "*yawn*", "aren't you tired?"],
  morning: ["good morning ☀️", "coffee?", "a new day!"],
  typing: ["tap tap tap", "you type so fast!", "writing a novel?", "keep going!", "clack clack"],
  copy: ["copied! 📋", "got it!", "⌘C ✓", "I'll remember"],
  dark: ["who turned off the lights?", "dark mode 😎", "spooky…"],
  light: ["too bright!", "my eyes!", "good morning?"],
  offline: ["the internet's gone!", "hello? wifi?", "offline 😱"],
  online: ["we're back online!", "wifi's back!", "phew, internet"],
  bye: ["bye, {name}!", "see ya, {name}", "{name} left 👋"],
  breather: ["time for a break? 🧃", "stretch with me!", "drink some water 💧", "rest your eyes 👀"],
  yum: ["yum!", "nom nom", "more please!", "🍪 ♥", "the best cookie"],
  windows: ["so many windows…", "tidy up?", "window party!"],
  xmas: ["happy holidays! 🎄", "ho ho ho", "❄️ let it snow"],
  halloween: ["boo! 🎃", "trick or treat!"],
  valentine: ["♥ love you", "be my valentine?"],
  friday: ["it's Friday! 🎉", "weekend soon!"],
  newyear: ["happy new year! 🎆", "🥂 new year!"],
  knock: ["knock knock 👀", "hello? anyone in there?", "*tap tap*"],
  attention: ["play with me?", "hey! over here!", "I'm bored…", "look at me!", "pssst"],
  sigh: ["…", "*sigh*", "nobody pets me", "meh"],
  think: ["I wonder what clouds taste like", "is a hotdog a sandwich?", "what if pixels have feelings", "🤔", "do fish get thirsty?", "I should learn the guitar", "life is good"],
  stars: ["✨ so many stars", "make a wish ✨", "the moon is pretty 🌙"],
  happy: ["life is great!", "I love it here ♥", "best friend!", "wheee ♥"],
  yawny: ["so sleepy…", "low battery… me, not you", "*yawn*", "need a nap"],
  jacks: ["workout! 💪", "one more!", "feel the burn"],
  tagalong: ["wait for me!", "where are we going?", "following you ♪"],
  cold: ["brr, it's chilly", "I need a scarf"],
  kungfu: ["hiyaa!", "kung fu! 🥋", "ha! hup!", "fear my fists"],
  skate: ["wheee~", "smooth", "look, no hands!", "ice skating ⛸"],
  bubbles: ["bubbles! 🫧", "pop!", "so round", "make a wish"],
  butterfly: ["a butterfly! 🦋", "come back!", "almost!", "so fast"],
  caught: ["got it! ♥", "hello, little friend", "so pretty"],
  snow: ["it's snowing! ❄", "brr ❄", "let it snow"],
  spring: ["spring! 🌸", "flowers ♪", "smells nice"],
  autumn: ["leaves falling 🍂", "cozy autumn", "crunchy leaves"],
  summer: ["fireflies ✦", "warm night", "summer vibes"],
  micronap: ["I'm awake!", "wasn't sleeping!", "huh? what?"],
  conductor: ["♪ maestro!", "bravo!", "and… crescendo!"],
  hello: ["hi, {name}!", "oh, {name}!", "welcome, {name} 👋"],
  space: ["whoosh!", "new space!", "where am I?"],
  download: ["download done! 📦", "it's here!", "fresh file!"],
  full: ["fully charged! 🔋", "100%!", "I'm full ⚡"],
  rain: ["my own little cloud…", "☔", "gloomy"],
  glitch: ["ERROR 404: Akko not found", "sYsTeM fAiLuRe", "01001000 01101001", "*bzzzt*"],
  jk: ["jk 😜", "gotcha 😝", "rebooted ✓"],
  magic: ["abracadabra ✨", "watch closely…", "nothing up my sleeve"],
  rabbit: ["ta-da! 🐰", "a bunny!", "magic ✨"],
  selfie: ["#selfie ✌️", "say cheese 📸", "my good side", "for the 'gram"],
  meditate: ["ommm…", "inner peace ✨", "zen mode"],
  drum: ["ba dum tss! 🥁", "drum solo!", "boom boom"],
  disco: ["disco time! 🪩", "boogie!", "feel the groove"],
  spy: ["🕵️ top secret", "nobody saw me", "mission: cookie"],
  breakdance: ["head spin!", "b-boy time", "watch this!"],
  teleport: ["teleport!", "*poof*", "over here!"],
  hiccup: ["hic!", "*hic*", "hic… sorry"],
  kite: ["my kite! 🪁", "higher!", "the wind's perfect"],
  raindance: ["rain dance! 💃", "come on, rain…", "it's working!"],
  umbrella: ["☂️ prepared!", "I'm dry ☂️", "smart, huh?"],
  fishing: ["gone fishing 🎣", "shh… they're biting", "patience…"],
  fish: ["a big one! 🐟", "dinner!", "got it!"],
  guitar: ["rock on 🤘", "🎸 solo!", "thank you, desktop!"],
  ghost: ["booo 👻", "I'm a ghost…", "ooOOoo"],
  photo: ["hold still! 📷", "smile, cursor!", "perfect shot"],
  build_snow: ["my snowman! ⛄", "he needs a hat"],
  build_spring: ["a flower! 🌷", "grow, grow"],
  build_summer: ["sand castle 🏰", "king of the beach"],
  build_autumn: ["my pumpkin 🎃", "biggest pumpkin ever"],
  gum: ["*chew chew*", "watch this"],
  pop: ["pop! 😳", "it's in my eyes!", "oops"],
  coffee: ["*sip* ☕", "ahh, coffee"],
  zoomies: ["COFFEE! ⚡", "zoomies!!", "I can see sounds"],
  banana: ["whoa—!", "who left that there?!", "banana! 🍌"],
  sleepwalk: ["zzz… 5 more minutes…", "*snore*", "mmm… cookies…"],
  wakeup: ["where am I?", "huh?!", "how did I get here?"],
};
/** Everything he says, in Russian. */
const RU: Phrases = {
  hi: ["привет!", "хей!", "йо!", "o/", "как дела?"],
  oops: ["ой", "ай!", "уф", "ого"],
  yay: ["ура!", "та-да!", "класс!", "у-у!", "легко"],
  fly: ["уиии!", "вжух", "полетели!", "пока!"],
  hmm: ["хмм…", "?", "а?"],
  poke: ["эй!", "ой!", "щекотно", "буп"],
  thrown: ["а-а-а!", "ааа!", "опять?!", "уиии!"],
  song: ["♪ ♫", "ля-ля ♪", "♫"],
  strain: ["ыыых", "грр", "нннгх"],
  look: ["новый образ", "модно", "✦"],
  top: ["залез!", "вид что надо", "привет сверху", "та-да!"],
  ride: ["ого!", "уиии!", "эй!", "аккуратно!"],
  peek: ["бу!", "ку-ку", "нашёл меня?"],
  laugh: ["ха-ха", "хи-хи", "ахах"],
  sneeze: ["апчхи!"],
  boo: ["бу!"],
  hehe: ["хе-хе"],
  gotcha: ["поймал!", "есть!"],
  fixed: ["починил!", "как новенькое"],
  phew: ["фух", "успел"],
  pet: ["♥", "хи-хи ♥", "ещё погладь!", "мурр…", "лучший день"],
  annoyed: ["хватит!", "эй, я занят!", "грр", "ну что такое!"],
  app_chat: ["кому пишешь? 👀", "передай привет!", "я тоже хочу смайлик", "не забудь ответить", "сплетни?"],
  app_browser: ["что ищем?", "открой мемы", "сколько вкладок…", "я тоже люблю интернет", "погугли меня"],
  app_code: ["опять баги?", "ты справишься!", "а тесты прошли?", "{ ✦ }", "коммить почаще", "красивый код"],
  app_ai: ["привет, Claude!", "о, коллега!", "спроси его про меня", "мы тут дружим"],
  app_music: ["♪ погромче!", "мой трек!", "♫ ♪", "диджей!"],
  app_files: ["наводишь порядок?", "сколько папок!", "тут уютно", "где мой файл?"],
  app_notes: ["что пишешь?", "запиши меня", "красиво пишешь", "это гениально"],
  app_mail: ["письмо!", "ответишь потом", "опять спам?", "📮"],
  app_video: ["что смотрим?", "попкорн есть?", "я тоже посмотрю"],
  app_design: ["красота", "чуть левее…", "мне нравится", "✦ стильно"],
  app_settings: ["ничего не сломай", "осторожно там", "а меня не выключишь?"],
  app_other: ["что тут у нас?", "интересно…", "о, привет", "я посмотрю?"],
  newwin: ["о, новое окно!", "что это там?", "ого!", "а это что?"],
  music: ["♪ о, музыка!", "мой трек!", "♫ ♪ ♫", "танцуем!"],
  ding: ["динь! 🔔", "тебе пишут!", "о, уведомление", "кто там?", "почта пришла?"],
  charge: ["⚡ вкусно!", "ммм, энергия", "заряжаюсь!", "⚡⚡⚡"],
  unplug: ["эй, зарядку верни!", "а как же я?", "ой, провод"],
  tired: ["мне бы подзарядиться…", "батарейка садится", "сил нет…"],
  missed: ["упс!", "ой, не успел!", "эх, моя вкусняшка…", "ой-ой 😅"],
  hungry: ["я проголодался… 🍪", "есть что-нибудь вкусненькое?", "в животе урчит", "не пора ли обедать?"],
  stuffed: ["я наелся! 🫃", "всё, больше не лезет", "ни кусочка больше", "может, потом…"],
  cheese: ["сыр! 📸", "я фотогеничный", "сними ещё!", "с лучшей стороны"],
  sleepy: ["ушёл?", "ну я тогда посплю", "тишина…"],
  zzz: ["хррр", "z z z", "zZz"],
  welcome: ["о, ты вернулся!", "с возвращением!", "я не спал, честно", "скучал!"],
  late: ["уже поздно… 🌙", "спать пора", "*зевает*", "ты не устал?"],
  morning: ["доброе утро ☀️", "кофе?", "новый день!"],
  typing: ["тук-тук-тук", "как быстро печатаешь!", "роман пишешь?", "давай-давай!", "клац-клац"],
  copy: ["скопировал! 📋", "запомнил!", "⌘C ✓", "держу"],
  dark: ["кто выключил свет?", "тёмная тема 😎", "страшновато…"],
  light: ["слишком ярко!", "глаза!", "уже утро?"],
  offline: ["интернет пропал!", "алё? вай-фай?", "офлайн 😱"],
  online: ["мы снова онлайн!", "вай-фай вернулся!", "фух, интернет"],
  bye: ["пока, {name}!", "до встречи, {name}", "{name} ушёл 👋"],
  breather: ["может, перерыв? 🧃", "потянись со мной!", "попей водички 💧", "дай глазам отдохнуть 👀"],
  yum: ["вкусно!", "ням-ням", "ещё хочу!", "🍪 ♥", "лучшая печенька"],
  windows: ["сколько окон…", "может, приберёмся?", "вечеринка окон!"],
  xmas: ["с праздниками! 🎄", "хо-хо-хо", "❄️ снежок"],
  halloween: ["бу! 🎃", "сладость или гадость!"],
  valentine: ["♥ люблю тебя", "будешь моей валентинкой?"],
  friday: ["пятница! 🎉", "скоро выходные!"],
  newyear: ["с новым годом! 🎆", "🥂 новый год!"],
  knock: ["тук-тук 👀", "алё, есть кто?", "*стук-стук*"],
  attention: ["поиграешь со мной?", "эй! я тут!", "мне скучно…", "посмотри на меня!", "пссс"],
  sigh: ["…", "*вздыхает*", "никто меня не гладит", "эх"],
  think: ["интересно, какие облака на вкус", "шаурма — это бутерброд?", "а вдруг у пикселей есть чувства", "🤔", "рыбы хотят пить?", "надо научиться играть на гитаре", "жизнь хороша"],
  stars: ["✨ сколько звёзд", "загадай желание ✨", "луна красивая 🌙"],
  happy: ["жизнь прекрасна!", "мне тут нравится ♥", "лучший друг!", "уиии ♥"],
  yawny: ["так хочется спать…", "батарейка села… у меня", "*зевает*", "мне бы вздремнуть"],
  jacks: ["зарядка! 💪", "ещё разок!", "чувствую мышцы"],
  tagalong: ["подожди меня!", "куда идём?", "я с тобой ♪"],
  cold: ["бр-р, прохладно", "мне бы шарфик"],
  kungfu: ["кия!", "кунг-фу! 🥋", "ха! хоп!", "бойтесь моих кулачков"],
  skate: ["уиии~", "как по маслу", "смотри, без рук!", "на коньках ⛸"],
  bubbles: ["пузыри! 🫧", "пуф!", "какой круглый", "загадай желание"],
  butterfly: ["бабочка! 🦋", "вернись!", "почти!", "какая быстрая"],
  caught: ["поймал! ♥", "привет, малышка", "какая красивая"],
  snow: ["снег идёт! ❄", "бр-р ❄", "снежок!"],
  spring: ["весна! 🌸", "цветочки ♪", "как пахнет"],
  autumn: ["листопад 🍂", "уютная осень", "хрустят листики"],
  summer: ["светлячки ✦", "тёплый вечер", "лето!"],
  micronap: ["я не сплю!", "я не спал!", "а? что?"],
  conductor: ["♪ маэстро!", "браво!", "и… крещендо!"],
  hello: ["привет, {name}!", "о, {name}!", "добро пожаловать, {name} 👋"],
  space: ["вжух!", "новый стол!", "где я?"],
  download: ["скачалось! 📦", "уже тут!", "свежий файл!"],
  full: ["зарядился! 🔋", "100%!", "я сытый ⚡"],
  rain: ["моя личная тучка…", "☔", "пасмурно"],
  glitch: ["ОШИБКА 404: Акко не найден", "сИсТеМнЫй СбОй", "01001000 01101001", "*бззззт*"],
  jk: ["шучу 😜", "попался 😝", "перезагрузился ✓"],
  magic: ["абракадабра ✨", "следи внимательно…", "в рукавах ничего"],
  rabbit: ["та-да! 🐰", "кролик!", "магия ✨"],
  selfie: ["#селфи ✌️", "скажи «сыр» 📸", "с лучшей стороны", "в сторис"],
  meditate: ["оммм…", "внутренний покой ✨", "режим дзен"],
  drum: ["ба-дум-тсс! 🥁", "соло на барабанах!", "бум-бум"],
  disco: ["дискотека! 🪩", "зажигаем!", "чувствую ритм"],
  spy: ["🕵️ совершенно секретно", "меня никто не видел", "миссия: печенька"],
  breakdance: ["на голове!", "брейк-данс!", "смотри!"],
  teleport: ["телепорт!", "*пуф*", "я тут!"],
  hiccup: ["ик!", "*ик*", "ик… извини"],
  kite: ["мой змей! 🪁", "выше!", "ветер что надо"],
  raindance: ["танец дождя! 💃", "ну давай, дождик…", "работает!"],
  umbrella: ["☂️ я готов!", "а мне сухо ☂️", "умно, да?"],
  fishing: ["ушёл на рыбалку 🎣", "тсс… клюёт", "терпение…"],
  fish: ["вот это улов! 🐟", "ужин!", "есть!"],
  guitar: ["рок! 🤘", "🎸 соло!", "спасибо, рабочий стол!"],
  ghost: ["у-у-у 👻", "я привидение…", "бу-у-у"],
  photo: ["замри! 📷", "улыбнись, курсор!", "отличный кадр"],
  build_snow: ["мой снеговик! ⛄", "ему нужна шапка"],
  build_spring: ["цветочек! 🌷", "расти, расти"],
  build_summer: ["замок из песка 🏰", "король пляжа"],
  build_autumn: ["моя тыква 🎃", "самая большая тыква"],
  gum: ["*жуёт*", "смотри"],
  pop: ["пуф! 😳", "в глаза попало!", "упс"],
  coffee: ["*глоток* ☕", "ах, кофе"],
  zoomies: ["КОФЕ! ⚡", "ВЖУУУХ!!", "я слышу цвета"],
  banana: ["оп—!", "кто тут бросил?!", "банан! 🍌"],
  sleepwalk: ["хрр… ещё 5 минуточек…", "*храпит*", "ммм… печеньки…"],
  wakeup: ["где я?", "а?!", "как я тут оказался?"],
};
/** What he says now: the table for the current language (shared by every copy of him on the page). */
const SAY: Phrases = { ...EN };
/** Speak English ("en") or Russian ("ru"). */
export function setLang(lang: string) { Object.assign(SAY, lang === "ru" ? RU : EN); }
const line = (key: string, name = "") => pick(SAY[key] ?? SAY.hmm).replace("{name}", name);


const PAINTS = ["invert(1) hue-rotate(180deg)", "sepia(1) saturate(5) hue-rotate(-18deg)", "grayscale(1) contrast(1.4)", "hue-rotate(150deg) saturate(1.6)", "blur(2.5px)"];

const ID = "translate(0px, 0px)";
/** What he may do while standing on the Dock (the rest needs the floor). */
/** How far his soles sit above the bottom of his box, as a share of his width (feet at 120.5 + half a 4.5 stroke, of a 72 x 104 drawing ending at 126). */
const FOOT = 3.25 / 72;
/** On a window his box stays a little above the reported top (tuned by eye on Finder and WhatsApp windows on macOS 26). */
const WINDOW_FOOT = -0.055;
/** Lively acts (cost energy, more likely when he is active) and calm ones (rest, more likely when he is not). */
const ENERGETIC = new Set(["run", "jetpack", "balloon", "wall", "cartwheel", "flip", "pogo", "chase", "climb", "ledges", "icons", "dig", "ball",
  "plane", "giant", "dive", "wrap", "trampoline", "monkeybars", "pullups", "pullright", "tightrope", "stomp", "shake", "jacks", "happyhops", "attention", "twirl", "moonwalk",
  "kungfu", "skate", "butterfly", "peekaboo", "breakdance", "teleport", "disco", "drum", "glitch",
  "guitar", "coffee", "banana", "raindance", "kite"]);
const CALM = new Set(["idle", "look", "nap", "yawn", "edgesit", "sit", "stretch", "stargaze", "sigh", "think", "sing", "typer", "snooze", "sneak",
  "bubbles", "micronap", "weather", "meditate", "fishing", "sleepwalk", "build"]);
/** Reactions to what happens on the computer: done wherever he is (on a roof, on the Dock), no need to get down first. */
const ANYWHERE = new Set(["hello", "space", "download", "full", "visit", "groove", "ding", "charge", "unplug", "tired", "cheese", "snooze", "welcome", "newwin",
  "typer", "copied", "theme", "net", "bye", "breather", "petted", "windows", "holiday"]);
const ON_DOCK = new Set(["walk", "run", "idle", "look", "wave", "hop", "head", "nap", "dance", "yawn", "juggle", "laugh", "sing", "notice", "edgesit", "flip", "twirl", "gear", "climb", "icons", "dock", "ledges", "late", "morning"]);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const coin = (p = 0.5) => Math.random() < p;
const tr = (x: number, y: number) => `${x.toFixed(1)}px ${y.toFixed(1)}px`;

// Element shapes, all centred so they work on top of the element's own transform.
const squash = (k: number, H: number) => `translateY(${((1 - k) * H / 2).toFixed(1)}px) scale(${(1 + (1 - k) * 0.35).toFixed(3)}, ${k.toFixed(3)})`;
const stretchDown = (k: number, H: number) => `translateY(${((k - 1) * H / 2).toFixed(1)}px) scale(${(1 - (k - 1) * 0.12).toFixed(3)}, ${k.toFixed(3)})`;
const stretchRight = (k: number, W: number) => `translateX(${((k - 1) * W / 2).toFixed(1)}px) scale(${k.toFixed(3)}, ${(1 - (k - 1) * 0.15).toFixed(3)})`;

/** Visible box of an element; for headings, just the text. */
function boxOf(el: HTMLElement): DOMRect {
  if (/^H[1-6]$/.test(el.tagName)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width > 0) return r;
  }
  return el.getBoundingClientRect();
}

/*
 * Effects (specks, bursts, the ball, the plane, the speech bubble) are made once and then only hidden, moved and
 * played again — never taken off the page. In WebKit, removing a layer makes it repaint the page underneath,
 * which on a full-screen overlay means a screen-sized picture kept in memory (some 55 MB) and a slow redraw.
 */
type Pooled = { el: HTMLElement; until: number };
const pools = new WeakMap<HTMLElement, Record<string, Pooled[]>>();
/** A free element of this kind for this host, made if there is none. */
function pooled(host: HTMLElement, kind: string, ms: number, make: () => HTMLElement): HTMLElement {
  let all = pools.get(host);
  if (!all) pools.set(host, (all = {}));
  const list = (all[kind] ??= []), now = performance.now();
  let item = list.find((p) => p.until <= now && p.el.isConnected);
  if (!item) {
    item = { el: make(), until: 0 };
    host.appendChild(item.el);
    list.push(item);
  }
  item.until = now + ms + 30;
  return item.el;
}

const BURST_EASE = "cubic-bezier(0.2, 0.7, 0.3, 1)";
/** A one-off shockwave with sparks at a point on screen. */
function burst(host: HTMLElement, x: number, y: number) {
  const el = pooled(host, "burst", 700, () => {
    const e = document.createElement("div");
    e.className = "rb-burst";
    e.innerHTML = "<b></b>" + "<i></i>".repeat(8);
    return e;
  });
  el.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
  el.firstElementChild!.animate([{ transform: "scale(0.4)", opacity: 1 }, { transform: "scale(5)", opacity: 0 }], { duration: 700, easing: BURST_EASE });
  el.querySelectorAll("i").forEach((spark, i) => {
    const a = `rotate(${i * 45 + (i % 2 ? 0 : 22)}deg)`;
    spark.animate([{ transform: `${a} translateY(-10px) scaleY(1)`, opacity: 1 }, { transform: `${a} translateY(-46px) scaleY(0.4)`, opacity: 0 }], { duration: 600, easing: BURST_EASE });
  });
}

const SPECK: Record<string, number> = { "rb-dust": 0.32, "rb-fire": 0.9, "rb-note": 0.95, "rb-heart": 0.95, "rb-bubble": 0.8, "rb-drop": 0.7,
  "rb-snow": 0.9, "rb-petal": 0.9, "rb-leaf": 0.9, "rb-spark": 0.9 };
/** A short-lived speck (dust, flame) that flies off by (dx, dy) and fades. */
function fleck(host: HTMLElement, cls: string, x: number, y: number, dx: number, dy: number, ms = 600) {
  const el = pooled(host, cls, ms, () => {
    const e = document.createElement("i");
    e.className = `rb-speck ${cls}`;
    return e;
  });
  el.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
  el.animate([{ transform: "translate(0px, 0px) scale(1)", opacity: SPECK[cls] ?? 0.5 }, { transform: `translate(${dx.toFixed(0)}px, ${dy.toFixed(0)}px) scale(2.2)`, opacity: 0 }], { duration: ms, easing: "ease-out" });
}

/** An ink doodle stuck onto an element for a few seconds; it rides along when the page scrolls. */
function stick(host: HTMLElement, target: HTMLElement, x: number, y: number) {
  const el = document.createElement("div");
  el.className = "rb-sticker";
  el.innerHTML = `<svg viewBox="0 0 30 30">${pick(STICKERS)}</svg>`;
  el.style.rotate = `${rand(-18, 18).toFixed(0)}deg`;
  const r0 = target.getBoundingClientRect();
  const dx = x - r0.left, dy = y - r0.top;
  host.appendChild(el);
  const end = performance.now() + 7000;
  const follow = () => {
    const r = target.getBoundingClientRect();
    el.style.left = `${r.left + dx}px`;
    el.style.top = `${r.top + dy}px`;
    if (performance.now() < end) requestAnimationFrame(follow);
    else { el.classList.add("out"); window.setTimeout(() => el.remove(), 450); }
  };
  follow();
}

export function startEngine(ctx: EngineCtx): () => void {
  {
    const { el, svg, hit, host, setPose, setLeft, setGear, page, mouse } = ctx;
    const scroller = ctx.scroller ?? document.documentElement;
    const TARGETS = ctx.targets;

    let alive = true;
    /** Next frame, but no more often than the fps cap. */
    const minDt = 1000 / Math.max(5, ctx.fps);
    const frame = () => new Promise<void>((r) => {
      const t0 = performance.now();
      const loop = (t: number) => { if (t - t0 >= minDt - 3) r(); else requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    const timers = new Set<number>();
    /** A plain pause that never throws. */
    const nap = (ms: number) => new Promise<void>((res) => { const t = window.setTimeout(() => { timers.delete(t); res(); }, ms); timers.add(t); });

    // ---- Interruption: a scroll during an element trick, or the user grabbing the bot, aborts the current act.
    const ABORT = new Error("abort");
    /** Thrown while he stands on a window that has just moved: he rides along, then carries on. */
    const RIDE = new Error("ride");
    let perch: { id: number; ox: number; x: number; y: number; w: number; h: number } | null = null, rideDue = false;
    const watch = { on: false, start: 0 };
    let grabbed = false;
    let pokes: number[] = [];
    let cut = false; // set by play(): abort the current act at the next check
    let wake: (() => void) | null = null; // ends the idle pause between acts early
    const fxAnims = new Set<Animation>();
    const undo = new Set<() => void>(); // cleanups for props an act has left on the page
    const cancelFx = () => { fxAnims.forEach((a) => a.cancel()); fxAnims.clear(); };
    const scrolled = () => watch.on && Math.abs(scroller.scrollTop - watch.start) > 24;
    const onScroll = () => { if (scrolled()) cancelFx(); };
    // The page's own scroll fires on window, not on <html>: listen where the events really come.
    const scrollSrc: EventTarget = scroller === document.documentElement ? window : scroller;
    scrollSrc.addEventListener("scroll", onScroll, { passive: true });
    const check = () => {
      onScroll(); // scroll events only fire on painted frames, so also look at the position directly
      if (!alive || grabbed || cut || scrolled()) throw ABORT;
      if (rideDue && perch) throw RIDE;
    };
    const hold = async (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { check(); await nap(Math.min(80, end - performance.now())); }
      check();
    };
    const fx = (target: HTMLElement, frames: Keyframe[], ms: number, opts: KeyframeAnimationOptions = {}) => {
      const a = target.animate(frames, { duration: ms, composite: "add", ...opts });
      fxAnims.add(a);
      a.finished.catch(() => {}).finally(() => fxAnims.delete(a));
      return a;
    };

    // ---- Geometry. (rx, ry) is the dock's translate: x from its CSS left, y from the floor (negative is up).
    let W = 44, H = 64, base = 16;
    const measure = () => { W = el.offsetWidth || 44; H = el.offsetHeight || 64; base = parseFloat(getComputedStyle(el).left) || 0; };
    const vw = () => window.innerWidth, vh = () => window.innerHeight;
    const maxX = () => vw() - base - W - 8;
    /** Right end of the floor it strolls on: stops short of the chat launcher when there is room. */
    const farEnd = () => {
      const l = ctx.avoid ? document.querySelector(ctx.avoid)?.getBoundingClientRect() : undefined;
      return l && l.left - base - W - 14 > 240 ? l.left - base - W - 14 : maxX();
    };
    const txAt = (px: number) => clamp(px - base - W / 2, 0, maxX());
    const feetX = () => base + rx + W / 2;
    const feetY = () => vh() + ry;

    // Pick up where a previous run left it (the host keeps the dock between runs).
    let rx = parseFloat(el.style.translate) || 0, ry = 0, rot = 0, scl = 1;
    const setPos = (x: number, y: number) => {
      rx = x; ry = y; el.style.translate = tr(x, y);
      if (bubble) { bubble.style.translate = tr(x + bx, y + by); bubbleAnims.forEach((a) => a.cancel()); bubbleAnims.clear(); }
    };
    const setRot = (r: number) => { rot = r; el.style.rotate = `${r.toFixed(1)}deg`; };
    const setScl = (s: number) => { scl = s; el.style.scale = `${s}`; };
    const botAnims = new Set<Animation>();
    /** Moves in progress (those that change where he is), so a speech bubble can ride along. */
    const flights = new Map<Animation, { frames: Keyframe[]; ms: number; easing: string }>();
    const anim = (frames: Keyframe[], ms: number, easing: string) => {
      const a = el.animate(frames, { duration: ms, easing, fill: "forwards" });
      botAnims.add(a);
      if (frames[0].translate != null) { flights.set(a, { frames, ms, easing }); carry(a, frames, ms, easing); }
      return a;
    };
    const done = (a: Animation) => a.finished.then(() => true, () => false).then((ok) => { botAnims.delete(a); flights.delete(a); return ok; });
    /** Stop every running flight where it is and keep that position. */
    const freeze = () => {
      const cs = getComputedStyle(el);
      const t = cs.translate === "none" ? [] : cs.translate.split(" ").map(parseFloat);
      const r = cs.rotate === "none" ? 0 : parseFloat(cs.rotate);
      const s = cs.scale === "none" ? 1 : parseFloat(cs.scale);
      setPos(t[0] || 0, t[1] || 0);
      setRot(r || 0);
      setScl(s || 1);
      botAnims.forEach((a) => a.cancel());
      botAnims.clear();
      flights.clear();
    };

    /** Fly through points [x, y, offset?] from where it is now. Never throws. */
    const glide = async (pts: Pt[], ms: number, easing = "ease-in-out") => {
      const frames: Keyframe[] = [{ translate: tr(rx, ry), offset: 0 }, ...pts.map(([px, py, o]) => (o == null ? { translate: tr(px, py) } : { translate: tr(px, py), offset: o }))];
      const a = anim(frames, ms, easing);
      if (await done(a)) { const l = pts[pts.length - 1]; setPos(l[0], l[1]); a.cancel(); }
    };
    const move = async (pts: Pt[], ms: number, easing?: string) => { await glide(pts, ms, easing); check(); };
    /** A jump: up fast, hang at the top, down fast. */
    const arc = async (tx: number, ty: number, h: number, ms: number) => {
      const a = anim([
        { translate: tr(rx, ry), easing: "cubic-bezier(0.2, 0.6, 0.4, 1)" },
        { translate: tr((rx + tx) / 2, Math.min(ry, ty) - h, ), easing: "cubic-bezier(0.6, 0, 0.8, 0.4)" },
        { translate: tr(tx, ty) },
      ], ms, "linear");
      if (await done(a)) { setPos(tx, ty); a.cancel(); }
      check();
    };
    const turn = async (to: number, ms: number, easing = "ease-in-out") => {
      const a = anim([{ rotate: `${rot}deg` }, { rotate: `${to}deg` }], ms, easing);
      if (await done(a)) { setRot(to); a.cancel(); }
    };
    const resize = async (to: number, ms: number) => {
      const a = anim([{ scale: `${scl}` }, { scale: `${to}` }], ms, "cubic-bezier(0.3, 1.5, 0.5, 1)");
      if (await done(a)) { setScl(to); a.cancel(); }
    };

    let facing = false;
    const face = (l: boolean) => { facing = l; setLeft(l); };
    // Each part exists once per copy of the drawing (see art.ts), so they are moved together.
    const $ = (sel: string) => [...svg.querySelectorAll<HTMLElement>(sel)];
    const P = { all: $(".rb-all"), body: $(".rb-body"), head: $(".rb-head"), eyes: $(".rb-eyes"), legL: $(".rb-leg.l"), legR: $(".rb-leg.r"), armL: $(".rb-arm.l"), armR: $(".rb-arm.r") };
    /** Limb animations of the walk in progress. */
    const gait = new Set<Animation>();
    const clearGait = () => { gait.forEach((a) => a.cancel()); gait.clear(); };

    /**
     * Walk in a straight line to (tx, ty): speeds up, slows down before arriving, and the legs swing by the
     * ground actually covered, so the feet never slide. Works on the floor, on walls and on top of things.
     *
     * The whole walk is worked out first and handed to the browser as a few short animations, so while he walks
     * no script runs and nothing is redrawn — the GPU just moves his layers. Keyframes sit only where a foot
     * lands or passes (every quarter of a step cycle), with sine easing between them; the steady middle of the
     * walk is one step cycle on repeat. That keeps the animations tiny however far he goes.
     */
    /** Walking pace factor, set once his feelings are known (see "How he feels"). */
    let pace = () => 1;
    const EASE_OUT = "cubic-bezier(0.61, 1, 0.88, 1)", EASE_IN = "cubic-bezier(0.12, 0, 0.39, 0)"; // quarter sine waves
    const go = async (tx: number, ty: number, o: GoOpts = {}) => {
      const speed = o.speed ?? SPEED * pace(), fast = speed > 90;
      const x0 = rx, y0 = ry, total = Math.hypot(tx - x0, ty - y0);
      if (total < 2) return;
      const dir = tx >= x0 ? 1 : -1;
      const pose = o.pose ?? (fast ? "run" : "walk");
      face(o.face ?? (o.back ? dir > 0 : dir < 0));
      setPose(pose);
      const acc = speed * 3.2, stride = (fast ? 30 : 16) * scl, dt = 1 / 60, HALF = Math.PI / 2;
      const SWING = fast ? 27 : 17, BOB = fast ? 3.4 : 2.2;
      // Step through the walk 60 times a second, noting every quarter of the step cycle.
      type Q = { t: number; k: number; q: number; sw: number; bob: number; lean: number; cruise: boolean };
      const pts: Q[] = [{ t: 0, k: 0, q: 0, sw: 0, bob: 0, lean: 0, cruise: false }];
      let v = 0, gone = 0, phase = 0, lean = 0, t = 0;
      for (let i = 0; gone < total - 0.5 && i < 60000; i++) {
        const want = Math.min(speed, Math.sqrt(2 * acc * (total - gone)) + 8);
        const dv = clamp(want - v, -acc * 1.8 * dt, acc * dt);
        v += dv;
        const step = Math.min(total - gone, v * dt), p0 = phase, g0 = gone;
        gone += step;
        t += dt;
        phase += (step / stride) * Math.PI;
        lean += ((fast ? 9 : 2.5) * (v / speed) + clamp(dv / (acc * dt), -1, 1) * (fast ? 8 : 3) - lean) * 0.18;
        const e = Math.min(1, 0.35 + v / speed);
        for (let q = Math.floor(p0 / HALF) + 1; q * HALF <= phase; q++) {
          const f = (q * HALF - p0) / (phase - p0), odd = q % 2, up = q % 4 === 1 ? 1 : -1;
          pts.push({ t: t - dt + f * dt, k: (g0 + f * step) / total, q, sw: odd ? up * SWING * e : 0, bob: odd ? -BOB * e : 0, lean, cruise: v > speed * 0.999 });
        }
      }
      const e = Math.min(1, 0.35 + v / speed);
      if (t - pts[pts.length - 1].t > 0.004) pts.push({ t, k: 1, q: -1, sw: Math.sin(phase) * SWING * e, bob: -Math.abs(Math.sin(phase)) * BOB * e, lean, cruise: false });
      else Object.assign(pts[pts.length - 1], { t, q: -1 });
      pts[pts.length - 1].k = 1;
      // The steady part, from one whole step cycle to another.
      const c0 = pts.findIndex((p) => p.cruise && p.q % 4 === 0);
      let c1 = -1;
      for (let i = pts.length - 1; i > c0; i--) if (pts[i].cruise && pts[i].q % 4 === 0) { c1 = i; break; }
      const steady = c0 >= 0 && c1 > c0;

      const u = W / 72;
      const run = (targets: HTMLElement[], frames: Keyframe[], opts: KeyframeAnimationOptions) => targets.forEach((target) => gait.add(target.animate(frames, opts)));
      /** Keyframes for a stretch of the walk. */
      const span = (from: number, to: number, prop: string, f: (p: Q) => string, wave: boolean): Keyframe[] => {
        const a = pts[from].t, d = pts[to].t - a || 1;
        return pts.slice(from, to + 1).map((p, i, list) => ({ [prop]: f(p), offset: i === list.length - 1 ? 1 : (p.t - a) / d, easing: !wave || p.q < 0 || list[i + 1]?.q < 0 ? "linear" : p.q % 2 ? EASE_IN : EASE_OUT }));
      };
      /** Something that swings with the steps: run-up, one cycle on repeat, slow-down. */
      const cycle = (target: HTMLElement[], f: (p: Q) => string) => {
        if (!steady) return run(target, span(0, pts.length - 1, "transform", f, true), { duration: t * 1000 });
        const cycles = (pts[c1].q - pts[c0].q) / 4, each = (pts[c1].t - pts[c0].t) / cycles;
        if (c0 > 0) run(target, span(0, c0, "transform", f, true), { duration: pts[c0].t * 1000 });
        run(target, span(c0, c0 + 4, "transform", f, true), { duration: each * 1000, iterations: cycles, delay: pts[c0].t * 1000 });
        run(target, span(c1, pts.length - 1, "transform", f, true), { duration: (t - pts[c1].t) * 1000, delay: pts[c1].t * 1000 });
      };
      /** Something that changes smoothly: the steady middle needs no keyframes of its own. */
      const smooth = (prop: string, f: (p: Q) => string): Keyframe[] => {
        const list = steady ? [...pts.slice(0, c0 + 1), ...pts.slice(c1)] : pts;
        return list.map((p, i) => ({ [prop]: f(p), offset: i === list.length - 1 ? 1 : p.t / t }));
      };
      if (pose === "roll") {
        run(P.all, smooth("transform", (p) => `rotate(${(dir * 360 * (o.roll ?? 1) * p.k).toFixed(1)}deg)`), { duration: t * 1000 });
      } else {
        const swing = (sign: number) => (p: Q) => `rotate(${(p.sw * sign).toFixed(1)}deg)`;
        cycle(P.legL, swing(1));
        cycle(P.legR, swing(-1));
        if (pose !== "balance") { cycle(P.armR, swing(1)); cycle(P.armL, swing(-1)); }
        cycle(P.all, pose === "sneak" ? (p) => `translateY(${(p.bob + 3).toFixed(2)}px) scaleY(0.86)` : (p) => `translateY(${p.bob.toFixed(2)}px) scaleY(1)`);
        if (pose !== "moon") run(P.body, smooth("transform", (p) => `rotate(${p.lean.toFixed(2)}deg)`), { duration: t * 1000 });
        run(P.head, smooth("transform", (p) => `translateX(${(p.lean * 0.3 * u).toFixed(2)}px)`), { duration: t * 1000 });
      }
      const a = anim(smooth("translate", (p) => tr(x0 + (tx - x0) * p.k, y0 + (ty - y0) * p.k)), t * 1000, "linear");
      const end = done(a);
      try {
        for (;;) {
          const ok = await Promise.race([end, nap(100)]);
          check();
          if (ok === undefined) continue;
          if (ok) { setPos(tx, ty); a.cancel(); }
          break;
        }
      } finally {
        clearGait();
      }
    };
    // ---- The desktop around him, when the host feeds one: windows front to back, desktop icons and the Dock,
    // in page px. He walks along the bottom of the screen; the Dock is a step he hops onto; windows and icons
    // are things to climb, and the windows in front of whatever he stands on hide him.
    const world = ctx.world;
    const blocks = () => world.blocks ?? [];
    const toX = (px: number) => px - base - W / 2; // his x for feet at page x
    /** The Dock's ends in his x (feet right over the edge) and its top in his y. */
    const dockSpan = () => { const d = blocks().find((b) => b.kind === 2); return d ? { l: toX(d.x), r: toX(d.x + d.w), y: d.y - vh() + W * FOOT } : null; };
    /** Up on the Dock? He walks along the bottom of the screen (in front of the Dock); the Dock is just something to climb. */
    let upDock = false;
    const inDock = (x: number) => { const d = dockSpan(); return !!d && x > d.l && x < d.r; };
    /** Ground level at x: the top of the Dock while he is up there, otherwise the bottom of the screen. */
    const gAt = (x: number) => (upDock && inDock(x) ? dockSpan()!.y : 0);
    const grounded = () => Math.abs(ry - gAt(rx)) < 1.5;
    const onDock = () => upDock && inDock(rx) && grounded();
    /** The stretch of ground he is on: the whole bottom of the screen, or the top of the Dock. Tricks stay inside it. */
    const seg = (): [number, number] => {
      const d = dockSpan(), max = farEnd();
      if (!onDock() || !d) return [0, max];
      return [d.l + W * 0.35, Math.max(d.l + W * 0.35, Math.min(max, d.r - W * 0.35))];
    };
    const fmin = () => seg()[0];
    const fmax = () => seg()[1];

    /** Walk (or run) to x: along the bottom of the screen, or along the Dock and down its end if he is up there. */
    const walkTo = async (x: number, o: GoOpts = {}) => {
      x = clamp(x, 0, maxX());
      const d = dockSpan();
      if (!d) upDock = false;
      if (d && onDock() && !inDock(x)) {
        const fast = (o.speed ?? SPEED) > 90, dir = x < rx ? -1 : 1, edge = dir > 0 ? d.r : d.l;
        await go(edge - dir * W * 0.3, d.y, o);
        face(dir < 0);
        setPose("hang");
        await arc(edge + dir * W * 0.65, 0, 14, fast ? 340 : 460);
        upDock = false;
        setPose("land");
        dust(2);
        await hold(fast ? 50 : 170);
      }
      return go(x, gAt(x), o);
    };
    /** From the floor in front of the Dock, a hop up onto it. */
    const hopUp = async () => {
      const d = dockSpan();
      if (!d || upDock) return;
      setPose("crouch");
      await hold(200);
      setPose("hang");
      await arc(rx, d.y, 22, 520);
      upDock = true;
      setPose("land");
      await hold(150);
    };
    const runTo = (x: number, o: GoOpts = {}) => walkTo(x, { speed: RUN, ...o });

    // ---- Small effects.
    /** Little hearts floating up from his head. */
    const hearts = (n = 3) => {
      const r = el.getBoundingClientRect();
      for (let i = 0; i < n; i++) fleck(host, "rb-heart", r.left + r.width * rand(0.25, 0.75), r.top + rand(0, 8), rand(-22, 22), -rand(28, 50), 1400);
    };
    const dust = (n = 3, x = feetX(), y = feetY()) => { for (let i = 0; i < n; i++) fleck(host, "rb-dust", x + rand(-8, 8), y - rand(1, 5), rand(-24, 24), -rand(6, 22)); };
    const quake = (p: number) => { if (page) fx(page, [0, -p, p * 0.7, -p * 0.4, p * 0.2, 0].map((v) => ({ transform: `translateY(${v}px)` })), 380); };
    /** Drop specks from under the bot until stopped: two per tick (here, and halfway back to the last spot). */
    const trail = (cls: string, every: number) => {
      let px = NaN, py = 0;
      const id = window.setInterval(() => {
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.bottom - 6;
        fleck(host, cls, x + rand(-5, 5), y, rand(-10, 10), rand(18, 34), 500);
        if (px === px) fleck(host, cls, (x + px) / 2 + rand(-5, 5), (y + py) / 2, rand(-10, 10), rand(18, 34), 500);
        px = x;
        py = y;
      }, every * 2);
      const stop = () => { window.clearInterval(id); undo.delete(stop); };
      undo.add(stop);
      return stop;
    };

    // The speech bubble rides above his head without any frame loop: it is placed once, then given the same
    // moves as the dock (same keyframes, shifted), so the GPU carries both along together.
    let bubble: HTMLElement | null = null, bubbleTimer = 0, bx = 0, by = 0;
    const bubbleAnims = new Set<Animation>();
    const shifted = (v: string) => { const [x, y] = v.split(" ").map(parseFloat); return tr((x || 0) + bx, (y || 0) + by); };
    const carry = (a: Animation, frames: Keyframe[], ms: number, easing: string) => {
      if (!bubble || frames[0].translate == null) return;
      const m = bubble.animate(frames.map((f) => ({ ...f, translate: shifted(f.translate as string) })), { duration: ms, easing, fill: "forwards" });
      m.currentTime = a.currentTime;
      bubbleAnims.add(m);
    };
    const POP: Keyframe[] = [{ transform: "translate(-50%, -70%) scale(0.5)", opacity: 0 }, { transform: "translate(-50%, -100%) scale(1)", opacity: 1 }];
    let bubbleEl = host.querySelector<HTMLElement>(".rb-say");
    const hush = () => { bubble?.classList.add("out"); bubble = null; bubbleAnims.forEach((a) => a.cancel()); bubbleAnims.clear(); };
    const say = (text: string, ms = 1500) => {
      // A quiet one keeps most thoughts to himself.
      const c = ctx.traits.chatty;
      if (c < 1 && Math.random() > 0.3 + c * 0.6) return;
      window.clearTimeout(bubbleTimer);
      bubbleAnims.forEach((a) => a.cancel());
      bubbleAnims.clear();
      if (!bubbleEl) {
        bubbleEl = document.createElement("div");
        bubbleEl.className = "rb-say out";
        host.appendChild(bubbleEl);
      }
      const b = bubbleEl;
      b.textContent = text;
      // Where he is right now (mid-flight too), and where the bubble goes: above the middle of his box.
      const r = el.getBoundingClientRect(), now = getComputedStyle(el).translate;
      const [cx, cy] = now === "none" ? [0, 0] : now.split(" ").map(parseFloat);
      bx = clamp(r.left + r.width / 2, 44, vw() - 44) - (cx || 0);
      by = Math.max(30, r.top - 4) - (cy || 0);
      b.style.translate = tr((cx || 0) + bx, (cy || 0) + by);
      b.classList.remove("out");
      b.animate(POP, { duration: 250, easing: "cubic-bezier(0.2, 0.9, 0.3, 1.5)" });
      bubble = b;
      flights.forEach((f, a) => carry(a, f.frames, f.ms, f.easing));
      bubbleTimer = window.setTimeout(hush, ms);
    };

    // ---- Always on: the eyes follow the cursor (or glance around on their own).
    // No frame loop: he looks again a few times a second while the pointer is moving, less often while it rests,
    // and only at each new glance when it is gone. The eyes glide between looks with a CSS transition.
    /** Since when the pointer rests on him (petting), and what to do when it has for a moment. */
    let overSince = 0, onPetted: (() => void) | null = null;
    let ex = 0, ey = 0, gx = 0, gy = 0, glanceAt = 0, near = false, over = false, lookTimer = 0, lookDue = 0, lookedAt = 0, headX = -1e4, headY = -1e4;
    /** Pause between looks while the pointer moves: short when it is close to him (so a grab is caught at once), longer when far. */
    const gap = () => (drag.down || (Math.abs(mouse.x - headX) < 170 && Math.abs(mouse.y - headY) < 170) ? 40 : 130);
    const lookIn = (ms: number) => {
      window.clearTimeout(lookTimer);
      lookDue = performance.now() + ms;
      lookTimer = window.setTimeout(look, ms);
    };
    const look = () => {
      if (!alive) return;
      const now = lookedAt = performance.now(), r = el.getBoundingClientRect(), idle = now - mouse.t;
      // Is the pointer on the bot? Lets a click-through overlay switch clicks on only where he is.
      const hr = hit.getBoundingClientRect(), pad = 6;
      const isOver = drag.down || (mouse.x >= hr.left - pad && mouse.x <= hr.right + pad && mouse.y >= hr.top - pad && mouse.y <= hr.bottom + pad && idle < 5000);
      if (isOver !== over) { over = isOver; overSince = over ? now : 0; ctx.onInteractive(over); }
      if (over && overSince && !drag.down && now - overSince > 1200) { overSince = 0; onPetted?.(); }
      const hx = headX = r.left + r.width / 2, hy = headY = r.top + r.height * 0.3;
      let tx = 0, ty = 0;
      const live = mouse.x >= 0 && idle < 3500;
      if (live) {
        const dx = mouse.x - hx, dy = mouse.y - hy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 140);
        tx = (dx / d) * 3.4 * k;
        ty = (dy / d) * 2.6 * k;
        near = d < 90 && idle < 1500;
        const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        [tx, ty] = [tx * c - ty * s, tx * s + ty * c];
      } else {
        near = false;
        if (now > glanceAt) { gx = coin(0.35) ? 0 : rand(-3, 3); gy = coin(0.35) ? 0 : rand(-1.2, 1.6); glanceAt = now + rand(700, 3000); }
        tx = gx;
        ty = gy;
      }
      if (facing) tx = -tx;
      if (Math.abs(tx - ex) > 0.12 || Math.abs(ty - ey) > 0.12) {
        ex = tx;
        ey = ty;
        const u = W / 72;
        const to = `translate(${(ex * u).toFixed(2)}px, ${(ey * u).toFixed(2)}px)`;
        P.eyes.forEach((e) => { e.style.transform = to; });
      }
      lookIn(drag.down || idle < 400 ? gap() : idle < 5200 ? 240 : Math.max(250, glanceAt - now + 20));
    };
    /** The pointer moved: look again soon. */
    const stir = () => { const g = gap(), now = performance.now(); if (alive && lookDue - now > g) lookIn(Math.max(0, g - (now - lookedAt))); };
    mouse.wake = stir;
    const onMouse = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = performance.now(); stir(); };
    // While held, pointer events always arrive (the hit area has capture), so keep the shared pointer fresh too.
    if (ctx.trackPointer) window.addEventListener("pointermove", onMouse, { passive: true });
    else hit.addEventListener("pointermove", onMouse, { passive: true });

    // ---- Being picked up and thrown.
    const drag = { down: false, px: 0, py: 0, ox: 0, oy: 0, moved: 0, t0: 0, samples: [] as [number, number, number][] };
    const onDown = (e: PointerEvent) => {
      if (e.button) return;
      e.preventDefault();
      try { hit.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      upDock = false;
      freeze();
      cancelFx();
      clearGait();
      grabbed = true;
      wake?.(); // resting between acts: pick him up now, not when the pause runs out
      lookIn(0);
      Object.assign(drag, { down: true, px: e.clientX, py: e.clientY, ox: rx - e.clientX, oy: ry - e.clientY, moved: 0, t0: performance.now(), samples: [[e.clientX, e.clientY, performance.now()]] });
    };
    const onDrag = (e: PointerEvent) => {
      if (!drag.down) return;
      drag.moved += Math.hypot(e.clientX - drag.px, e.clientY - drag.py);
      drag.px = e.clientX;
      drag.py = e.clientY;
      drag.samples.push([e.clientX, e.clientY, performance.now()]);
      if (drag.samples.length > 6) drag.samples.shift();
    };
    const onUp = () => { drag.down = false; };
    hit.addEventListener("pointerdown", onDown);
    hit.addEventListener("pointermove", onDrag);
    hit.addEventListener("pointerup", onUp);
    hit.addEventListener("pointercancel", onUp);
    hit.addEventListener("lostpointercapture", onUp); // up/cancel can get lost (window switch): never stay stuck in the hand
    measure();
    lookIn(60);

    const dragged = async () => {
      el.classList.add("held");
      el.style.transformOrigin = "50% 22%"; // swings from the head while held
      setScl(1);
      let hard = false, poked = false, landed: WorldBlock | null = null;
      for (;;) {
        setPose("held");
        let ang = ((rot % 360) + 540) % 360 - 180, av = 0, lastX = rx;
        while (alive && drag.down) {
          await frame();
          const nx = drag.px + drag.ox, ny = Math.min(H * 0.3, drag.py + drag.oy);
          av = (av + (nx - lastX) * 0.9 - ang * 0.14) * 0.84;
          ang = clamp(ang + av, -80, 80);
          lastX = nx;
          setPos(nx, ny);
          setRot(ang);
        }
        if (!alive) return;
        const s = drag.samples, a0 = s[0], a1 = s[s.length - 1], sdt = Math.max(16, a1[2] - a0[2]) / 1000;
        let vx = clamp((a1[0] - a0[0]) / sdt, -2800, 2800), vy = clamp((a1[1] - a0[1]) / sdt, -2800, 2800);
        if (performance.now() - a1[2] > 120) vx = vy = 0;
        poked = drag.moved < 6 && performance.now() - drag.t0 < 400;
        if (Math.hypot(vx, vy) > 900) { hard = true; say(pick(SAY.thrown)); }
        let x = rx, y = ry, spin = vx * 0.35, last = performance.now(), roof: WorldBlock | null = null;
        upDock = false;
        const lo = -base, hi = vw() - base - W, top = -(vh() - H);
        while (alive && !drag.down) {
          await frame();
          const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.05);
          last = now;
          vy += GRAVITY * dt;
          const py0 = y;
          x += vx * dt;
          y += vy * dt;
          ang += spin * dt;
          if (x < lo) { x = lo; vx = Math.abs(vx) * 0.55; spin *= -0.5; }
          if (x > hi) { x = hi; vx = -Math.abs(vx) * 0.55; spin *= -0.5; }
          if (y < top) { y = top; vy = Math.abs(vy) * 0.4; }
          // Coming down from above onto a roof (a window, an icon, the Dock) lands on it; off its end, he falls on.
          const px = base + x + W / 2;
          if (roof && !(px >= roof.x && px <= roof.x + roof.w && blocks().includes(roof))) roof = null;
          if (!roof && vy > 0) { const l = below(px, py0); if (l.b && y >= l.y) roof = l.b; }
          const g = roof ? (roof.kind === 2 ? roof.y - vh() + W * FOOT : topOf(roof)) : 0;
          if (y >= g) {
            y = g;
            if (vy > 240) { vy *= -0.45; vx *= 0.72; spin = vx * 0.4; dust(3, base + x + W / 2, vh() + g); }
            else { vy = 0; vx *= 1 - Math.min(1, 9 * dt); spin *= 1 - Math.min(1, 9 * dt); if (Math.abs(vx) < 16) break; }
          }
          setPos(x, y);
          setRot(ang);
        }
        if (!alive) return;
        if (drag.down) continue;
        setPos(x, roof ? (roof.kind === 2 ? roof.y - vh() + W * FOOT : topOf(roof)) : 0);
        landed = roof;
        setRot(ang);
        await turn(Math.round(rot / 360) * 360, 260, "cubic-bezier(0.3, 1.4, 0.5, 1)");
        if (!drag.down) break;
      }
      if (!alive) return; // stopped while he settled: no perching, speech or hops on a paused bot
      setRot(0);
      el.style.transformOrigin = "";
      el.classList.remove("held");
      setPos(clamp(rx, 0, maxX()), ry);
      settleOn(landed);
      grabbed = false;
      if (poked) {
        const t = performance.now();
        pokes = pokes.filter((p) => t - p < 5000);
        pokes.push(t);
        noticed(0.02);
        if (pokes.length >= 4) {
          // Poked again and again: enough.
          feel(0, -0.08);
          setPose("dizzy");
          say(line("annoyed"));
          await nap(1300);
        } else if (coin(0.45)) {
          // A friendly poke: he likes it.
          setPose("cheer");
          say(line("pet"));
          hearts(3);
          await glide([[rx, ry - 18, 0.5], [rx, ry]], 360);
          await nap(500);
        } else {
          setPose("scared");
          say(pick(SAY.poke));
          await glide([[rx, ry - 26, 0.5], [rx, ry]], 380);
          await nap(450);
        }
      } else if (hard) {
        setPose("dizzy");
        await nap(1700);
      } else {
        setPose("land");
        await nap(350);
      }
    };

    /** Fall onto whatever is below (a window roof, the Dock, the floor), upright again. Never throws. */
    const drop = async (dx = 0, from: WorldBlock | null = null) => {
      const tx = clamp(rx + dx, 0, maxX()), land = below(base + tx + W / 2, ry, from), ty = land.y;
      setPose("fall");
      const ms = clamp(Math.sqrt(Math.max(1, ty - ry)) * 34, 380, 1000);
      const tilted = Math.abs(rot % 360) > 0.5;
      await Promise.all([
        glide([[(rx + tx) / 2, ry - 18, 0.3], [tx, ty]], ms, "cubic-bezier(0.5, 0, 0.85, 0.6)"),
        tilted ? turn(Math.round(rot / 360) * 360, ms * 0.7) : null,
      ]);
      if (grabbed || !alive) return;
      setRot(0);
      settleOn(land.b);
      setPose("land");
      dust(2);
      await nap(300);
    };

    /** After every act: tidy up whatever it left behind and get back onto the floor. */
    const recover = async () => {
      watch.on = false;
      el.getAnimations().forEach((a) => { const k = (a as CSSAnimation).animationName; if (!k && a.effect && "getKeyframes" in a.effect && (a.effect as KeyframeEffect).getKeyframes().some((f) => "opacity" in f || "filter" in f)) a.cancel(); });
      cancelFx();
      [...undo].forEach((f) => f());
      undo.clear();
      clearGait();
      aim = null;
      if (!alive) { unperch(); return occlude([]); }
      if (grabbed) { unperch(); occlude([]); return dragged(); }
      freeze();
      if (scl !== 1) await resize(1, 240);
      if (!alive || grabbed) return; // stopped or picked up meanwhile: nothing more to animate here
      // The window under him moved during the act (RIDE): ride along with it instead of falling off.
      if (rideDue && perch && Math.abs(rot % 360) < 0.5) {
        try { await ride(); } catch { return; } // grabbed or stopped mid-ride: handled on the next turn
      }
      if (Math.abs(rot % 360) < 0.5 && onPerchTop()) { setRot(0); occlude(frontOf(byId(perch!.id)!)); return; }
      unperch();
      if (Math.abs(rot % 360) > 0.5 || !grounded()) await drop();
      else { setRot(0); setPos(clamp(rx, 0, maxX()), ry); occlude([]); }
    };

    const leap = async (y: number, flip = false, crouch = true) => {
      if (crouch) { setPose("crouch"); await hold(240); }
      setPose(flip ? "flip" : "hang");
      const ms = clamp(440 + Math.sqrt(Math.max(1, -y)) * 14, 480, 900);
      await move([[rx, y - 46, 0.62], [rx, y]], ms, "cubic-bezier(0.25, 0.7, 0.4, 1)");
    };

    const approach = async (target: HTMLElement, px: (r: DOMRect) => number) => {
      await runTo(txAt(px(boxOf(target))));
      return boxOf(target);
    };

    // ---- Finding things to play with.
    const candidates = (kind: "top" | "bottom") => {
      const h = vh();
      if (!TARGETS) return []; // no page to play with (e.g. a desktop overlay)
      return [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((t) => {
        const r = boxOf(t);
        if (r.width < 44 || r.height < 18 || r.left < 0 || r.right > vw() - 4) return false;
        return kind === "top" ? r.top > 130 && r.top < h - 110 : r.bottom > 150 && r.bottom < h - H - 36 && r.height < 460;
      });
    };
    const standY = (r: DOMRect) => r.top - vh();
    const hangY = (r: DOMRect) => r.bottom - 2 - (vh() - H);
    const steps = [0, 0.4, 0.55, 0.7, 0.85, 1];
    const tugs = [0, 1, 0.72, 1.06, 0.86, 1];

    let gearNow: Gear = ctx.getGear();
    const A: Record<string, Act> = {};

    // ================= On the floor =================
    A.walk = { w: 4, run: async () => {
      const max = farEnd();
      let to = rand(0, max);
      if (Math.abs(to - rx) < 60) to = clamp(rx + (rx > max / 2 ? -1 : 1) * rand(90, 220), 0, max);
      await walkTo(to);
    } };
    A.run = { w: 2, run: async () => {
      const max = farEnd();
      const to = rx > max / 2 ? rand(0, max * 0.3) : rand(max * 0.6, max);
      await runTo(to, { speed: RUN * rand(1, 1.5) });
      if (coin(0.5)) { setPose("skid"); dust(4); await hold(420); }
    } };
    for (const [name, w, ms] of [["idle", 1, 1400], ["look", 1, 2200], ["wave", 0.8, 1800], ["hop", 0.9, 1300], ["head", 0.8, 3400], ["nap", 0.5, 4200], ["dance", 1, 2600], ["yawn", 0.8, 1700], ["juggle", 1.2, 3400]] as [string, number, number][]) {
      A[name] = { w, run: async () => { setPose(name === "yawn" ? "stretch" : name); await hold(ms); } };
    }
    A.laugh = { w: 0.7, run: async () => { setPose("laugh"); say(line("laugh")); await hold(1500); } };
    A.sing = { w: 0.7, run: async () => { setPose("dance"); say(pick(SAY.song), 2200); await hold(2400); } };
    A.notice = { w: 40, ok: () => near && grounded(), run: async () => {
      noticed(0.02);
      face(mouse.x < feetX());
      setPose(coin(0.3) ? "scared" : "wave");
      say(pick(SAY.hi));
      await hold(1600);
    } };
    A.edgesit = { w: 1, run: async () => {
      const g = ry;
      setPose("edgesit");
      await move([[rx, g + W * (15 / 72)]], 320, "ease-out");
      await hold(rand(2600, 4000));
      setPose("hang");
      await move([[rx, g - 12, 0.6], [rx, g]], 420);
      setPose("land");
      await hold(300);
    } };
    A.flip = { w: 0.9, run: async () => {
      setPose("crouch");
      await hold(220);
      setPose("flip");
      await arc(rx, ry, 52, 760);
      setPose("land");
      dust(2);
      await hold(320);
    } };
    A.trip = { w: 0.7, run: async () => {
      await runTo(clamp(rx + (coin() ? -1 : 1) * rand(70, 140), fmin(), fmax()));
      setPose("trip");
      say(pick(SAY.oops), 1100);
      await hold(2400);
    } };
    A.moonwalk = { w: 1.1, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      say(pick(SAY.song));
      await walkTo(clamp(rx + d * rand(140, 260), fmin(), max), { speed: 40, back: true, pose: "moon" });
      setPose("cheer");
      await hold(600);
    } };
    A.sneak = { w: 0.9, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      await walkTo(clamp(rx + d * rand(70, 130), fmin(), max), { speed: 22, pose: "sneak" });
      setPose("look");
      await hold(1400);
      await walkTo(clamp(rx + d * rand(50, 90), fmin(), max), { speed: 22, pose: "sneak" });
    } };
    A.cartwheel = { w: 1.1, run: async () => {
      const lap = Math.PI * H * 0.9, max = fmax();
      const n = coin(0.4) ? 2 : 1, d = rx + lap * n < max ? (rx - lap * n > fmin() && coin() ? -1 : 1) : -1;
      if (rx + d * lap * n < fmin() || rx + d * lap * n > fmax()) return A.flip.run(el);
      await go(rx + d * lap * n, ry, { speed: 190, pose: "roll", roll: n });
      setPose("cheer");
      await hold(700);
    } };
    A.dive = { w: 0.9, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      await runTo(clamp(rx + d * rand(120, 200), fmin(), max), { speed: RUN * 1.3 });
      setPose("dive");
      say(pick(SAY.fly), 900);
      const stop = trail("rb-dust", 70);
      await move([[clamp(rx + d * 130, fmin(), fmax()), ry]], 800, "cubic-bezier(0.1, 0.7, 0.3, 1)");
      stop();
      await hold(600);
      setPose("land");
      await hold(300);
    } };
    A.twirl = { w: 0.8, run: async () => {
      setPose("twirl");
      await hold(1500);
      setPose("dizzy");
      await hold(1700);
    } };
    A.pogo = { w: 1, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      face(d < 0);
      for (let i = 0; i < 5; i++) {
        setPose(i === 4 ? "flip" : "hang");
        await arc(clamp(rx + d * rand(46, 70), fmin(), max), ry, 30 + i * 12, i === 4 ? 760 : 400 + i * 20);
        setPose("land");
        dust(2);
        await hold(110);
      }
      await hold(300);
    } };
    A.sneeze = { w: 0.7, run: async () => {
      setPose("sneeze");
      await hold(700);
      const d = facing ? -1 : 1;
      for (let i = 0; i < 6; i++) fleck(host, "rb-dust", feetX() + d * 14, feetY() - H * 0.62, d * rand(20, 60), rand(-16, 16));
      say(line("sneeze"), 1100);
      await move([[clamp(rx - d * 36, fmin(), fmax()), ry]], 280, "ease-out");
      await hold(900);
    } };
    A.wrap = { w: 0.8, run: async () => {
      const goLeft = rx < maxX() / 2;
      await walkTo(goLeft ? 0 : maxX(), { speed: RUN * 1.3 });
      await go(goLeft ? -base - W - 30 : vw() - base + 30, ry, { speed: RUN * 1.3 });
      await hold(800);
      const [a2, b2] = seg(), g2 = 0;
      setPos(goLeft ? vw() - base + 30 : -base - W - 30, g2);
      await go(goLeft ? rand(a2 + (b2 - a2) * 0.45, b2) : rand(a2, a2 + (b2 - a2) * 0.55), g2, { speed: RUN * 1.3 });
      setPose("wave");
      await hold(900);
    } };
    A.dig = { w: 1, run: async () => {
      setPose("crouch");
      await hold(220);
      const max = fmax();
      for (let i = 0, n = coin(0.5) ? 2 : 1; i < n; i++) {
        dust(5);
        await move([[rx, H + 12]], 420, "ease-in");
        await hold(450);
        setPos(clamp(rx + (coin() ? -1 : 1) * rand(140, 420), fmin(), max), H + 12);
        setPose("look");
        await move([[rx, H * 0.6]], 380, "ease-out");
        await hold(1300);
      }
      setPose("hang");
      dust(4);
      await arc(rx, gAt(rx), H * 0.6 + 34, 520);
      setPose("land");
      say(line("boo"), 1000);
      await hold(500);
    } };
    A.gear = { w: 1.4, run: async () => {
      setPose("crouch");
      await hold(260);
      burst(host, feetX(), feetY() - H * 0.8);
      gearNow = pick(GEARS.filter((g) => g !== gearNow));
      setGear(gearNow);
      setPose("cheer");
      if (gearNow !== "none") say(pick(SAY.look));
      await hold(1100);
    } };
    A.giant = { w: 0.9, run: async () => {
      burst(host, feetX(), feetY() - H / 2);
      setPose("cheer");
      await resize(2.3, 520);
      check();
      const d = rx > fmax() / 2 ? -1 : 1;
      face(d < 0);
      for (let i = 0; i < 4; i++) {
        setPose("fall");
        await arc(clamp(rx + d * 54, fmin(), fmax()), ry, 40, 460);
        setPose("land");
        quake(7);
        dust(6);
        await hold(260);
      }
      setPose("laugh");
      say(line("hehe"));
      await hold(900);
      burst(host, feetX(), feetY() - H);
      await resize(1, 380);
    } };
    A.tiny = { w: 0.8, run: async () => {
      burst(host, feetX(), feetY() - H / 2);
      await resize(0.45, 320);
      check();
      const max = fmax();
      for (let i = 0; i < 3; i++) await walkTo(rx > max / 2 ? rand(0, max * 0.35) : rand(max * 0.65, max), { speed: RUN * 1.7 });
      setPose("scared");
      await hold(350);
      burst(host, feetX(), feetY() - H / 4);
      await resize(1, 380);
    } };
    A.shove = { w: 0.9, ok: () => !!page, run: async () => {
      const right = rx > maxX() / 2, d = right ? 1 : -1;
      await runTo(right ? maxX() : 0);
      face(!right);
      setPose("push");
      for (let i = 0; i < 3; i++) {
        const p = (i === 2 ? 30 : 9 + i * 4) * d;
        if (i === 1) say(pick(SAY.strain), 1000);
        fx(page!, [{ transform: ID }, { offset: 0.5, transform: `translateX(${p}px) skewX(${(-p / 22).toFixed(2)}deg)` }, { offset: 0.75, transform: `translateX(${(-p * 0.3).toFixed(1)}px)` }, { transform: ID }], i === 2 ? 900 : 620, { easing: "ease-out" });
        await hold(i === 2 ? 520 : 680);
      }
      setPose("trip");
      await move([[clamp(rx - d * 80, fmin(), fmax()), ry]], 420, "ease-out");
      await hold(2000);
    } };
    A.ball = { w: 1.3, run: async () => {
      let b = host.querySelector<HTMLElement>(".rb-ball")!;
      if (!b) {
        b = document.createElement("i");
        b.className = "rb-ball out";
        host.appendChild(b);
      }
      const s = { x: feetX() + (rx > fmax() / 2 ? -1 : 1) * W * 0.7, y: vh(), vx: 0, vy: 0, a: 0, live: true };
      const put = () => { b.style.translate = tr(s.x, s.y); b.style.rotate = `${s.a.toFixed(0)}deg`; };
      const kill = () => { s.live = false; undo.delete(kill); b.classList.add("out"); };
      undo.add(kill);
      put();
      b.classList.remove("out");
      (async () => {
        let last = performance.now();
        while (s.live && alive) {
          await frame();
          const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.05);
          last = now;
          s.vy += 1700 * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.a += s.vx * dt * 3;
          if (s.y >= vh()) { s.y = vh(); s.vy = s.vy > 90 ? -s.vy * 0.62 : 0; s.vx *= 1 - Math.min(1, 1.4 * dt); }
          if (s.x < 9) { s.x = 9; s.vx = Math.abs(s.vx) * 0.7; }
          if (s.x > vw() - 9) { s.x = vw() - 9; s.vx = -Math.abs(s.vx) * 0.7; }
          put();
        }
      })();
      await hold(450);
      for (let i = 0; i < 3; i++) {
        const d = s.x < vw() / 2 ? 1 : -1;
        await runTo(txAt(s.x - d * W * 0.7), { speed: RUN * 1.25 });
        if (Math.abs(s.x - feetX()) > 110) await runTo(txAt(s.x - d * W * 0.7), { speed: RUN * 1.4 });
        face(d < 0);
        setPose("kick");
        await hold(130);
        if (Math.abs(s.x - feetX()) < 130) { s.vx = d * rand(380, 660); s.vy = -rand(420, 700); dust(2); }
        await hold(520);
        setPose("look");
        await hold(500);
      }
      setPose("cheer");
      say(pick(SAY.yay));
      await hold(900);
      kill();
    } };
    A.plane = { w: 1.1, run: async () => {
      const d = feetX() < vw() / 2 ? 1 : -1;
      face(d < 0);
      setPose("throw");
      await hold(280);
      let p = host.querySelector<HTMLElement>(".rb-plane")!;
      if (!p) {
        p = document.createElement("div");
        p.className = "rb-plane";
        p.innerHTML = '<svg viewBox="0 0 30 30"><path d="M3 14 L27 4 L18 26 L14 17 Z M14 17 L27 4"/></svg>';
        host.appendChild(p);
      }
      p.style.scale = d < 0 ? "1 -1" : "";
      const x0 = feetX() + d * 12, y0 = feetY() - H * 0.8, w = vw(), h = vh();
      const pts = [[x0, y0], [x0 + d * w * 0.18, y0 - h * 0.3], [x0 + d * w * 0.34, y0 - h * 0.12], [x0 + d * w * 0.5, y0 - h * 0.45], [x0 + d * w * 0.66, y0 - h * 0.26], [d > 0 ? w + 80 : -80, y0 - h * 0.55]];
      const frames = pts.map((q, i) => {
        const n = pts[Math.min(i + 1, pts.length - 1)], m = pts[Math.max(i - 1, 0)];
        const ang = (Math.atan2(n[1] - m[1], n[0] - m[0]) * 180) / Math.PI;
        return { translate: tr(q[0], q[1]), rotate: `${(ang + 22 * d).toFixed(0)}deg`, opacity: 1 };
      });
      p.animate(frames, { duration: 2800, easing: "cubic-bezier(0.3, 0, 0.7, 0.6)" });
      setPose("look");
      await hold(1000);
      setPose("wave");
      say(pick(SAY.fly));
      await hold(1500);
    } };
    A.balloon = { w: 1.2, run: async () => {
      setPose("float");
      const h = vh() * rand(0.4, 0.72), max = maxX();
      const x1 = clamp(rx + rand(-1, 1) * vw() * 0.25, fmin(), max), x2 = clamp(x1 + rand(-1, 1) * vw() * 0.3, fmin(), max);
      face(x1 < rx);
      await move([[(rx + x1) / 2 + 20, -h * 0.5, 0.5], [x1, -h]], 3000);
      face(x2 < rx);
      await move([[(rx + x2) / 2, -h - 36, 0.5], [x2, -h + 10]], 2600);
      burst(host, feetX() + (facing ? -18 : 18), feetY() - H * 1.6);
      setPose("scared");
      await hold(420);
      if (coin(0.55)) {
        setPose("glide");
        { const x = clamp(rx + rand(-60, 60), 0, maxX()); await move([[rx + 40, ry * 0.66, 0.33], [rx - 40, ry * 0.33, 0.66], [x, gAt(x)]], 3200, "linear"); }
        setPose("land");
        await hold(300);
      } else {
        await drop();
        check();
        setPose("dizzy");
        await hold(1500);
      }
    } };
    A.jetpack = { w: 1.3, run: async () => {
      setPose("crouch");
      await hold(260);
      setPose("jet");
      say(pick(SAY.fly), 900);
      const max = maxX(), top = -(vh() - H - 70);
      for (let i = 0, n = 3 + Math.floor(rand(0, 3)); i < n; i++) {
        const x = rx < max / 2 ? rand(max * 0.45, max) : rand(0, max * 0.55), y = rand(top, -90);
        face(x < rx);
        const ms = clamp(Math.hypot(x - rx, y - ry) * 2.4, 700, 1700);
        const loop = coin(0.3);
        await Promise.all([move([[x, y]], ms, "cubic-bezier(0.45, 0, 0.3, 1)"), loop ? turn(rot + (x < rx ? -360 : 360), ms) : turn((x < rx ? -1 : 1) * 16, 300)]);
        setRot(((rot % 360) + 540) % 360 - 180);
      }
      await Promise.all([move([[rx, gAt(rx)]], clamp((gAt(rx) - ry) * 2.2, 500, 1400), "cubic-bezier(0.3, 0, 0.4, 1)"), turn(0, 300)]);
      setPose("land");
      dust(5);
      await hold(350);
      setPose("cheer");
      await hold(700);
    } };
    A.wall = { w: 1.4, run: async () => {
      const leftSide = rx < maxX() / 2, sgn = leftSide ? 1 : -1;
      const wx = leftSide ? -base - W / 2 + 2 : vw() - base - W / 2 - 2;
      await runTo(leftSide ? 0 : maxX());
      setPose("crouch");
      await hold(200);
      setPose("hang");
      await Promise.all([move([[wx, -56]], 320, "ease-out"), turn(sgn * 90, 320)]);
      const ceil = coin(0.5), up = ceil ? vh() - H * 0.9 : vh() * rand(0.4, 0.75);
      await go(wx, -up, { speed: 120, face: leftSide });
      if (!ceil) {
        setPose("wave");
        say(pick(SAY.hi));
        await hold(1400);
        setPose("flip");
        const x = clamp(leftSide ? rand(120, 320) : maxX() - rand(120, 320), fmin(), fmax());
        await Promise.all([arc(x, gAt(x), 50, 900), turn(0, 600)]);
        setPose("land");
        dust(4);
        await hold(400);
        return;
      }
      const cx = wx + sgn * H * 0.7;
      await Promise.all([move([[cx, -vh() + 2]], 300), turn(sgn * 180, 300)]);
      await go(cx + sgn * rand(160, Math.min(520, vw() * 0.4)), ry, { speed: 80, face: leftSide });
      setPose("look");
      say(pick(SAY.hmm), 900);
      await hold(1000);
      setPose("scared");
      await hold(350);
      if (coin(0.5)) {
        setPose("glide");
        await turn(sgn * 360, 320);
        setRot(0);
        { const x = clamp(rx, 0, maxX()); await move([[rx + 36, ry * 0.66, 0.33], [rx - 36, ry * 0.33, 0.66], [x, gAt(x)]], 3000, "linear"); }
        setPose("land");
        await hold(300);
      } else {
        await drop();
        check();
        setPose("dizzy");
        await hold(1500);
      }
    } };
    A.chase = { w: 1.6, ok: () => ctx.traits.follow && mouse.x > 0 && performance.now() - mouse.t < 6000 && mouse.y < vh() - 90, run: async () => {
      say("!", 700);
      setPose("scared");
      await hold(350);
      for (let i = 0; i < 3; i++) {
        await runTo(txAt(mouse.x), { speed: RUN * 1.3 });
        const want = mouse.y - vh() + H * 0.75, reach = Math.abs(mouse.x - feetX()) < 40 && want > -360;
        setPose("crouch");
        await hold(180);
        setPose("hang");
        if (reach) {
          await move([[rx, want]], 380, "cubic-bezier(0.2, 0.7, 0.4, 1)");
          burst(host, feetX(), feetY() - H);
          say(line("gotcha"));
          await drop();
          check();
          setPose("cheer");
          await hold(1000);
          return;
        }
        await arc(rx, ry, Math.min(300, -want * 0.7), 700);
        setPose("land");
        await hold(250);
      }
      setPose("look");
      say(pick(SAY.hmm));
      await hold(1100);
    } };
    A.theme = { w: 0.7, ok: () => {
      const r = ctx.themeToggle ? document.querySelector(ctx.themeToggle)?.getBoundingClientRect() : undefined;
      return !!r && r.width > 0 && r.top >= 0 && r.bottom < vh() - 220;
    }, run: async () => {
      const btn = document.querySelector<HTMLElement>(ctx.themeToggle);
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      await runTo(txAt(r.left + r.width / 2));
      setPose("charge");
      await hold(650);
      await leap(r.top - vh(), true, false);
      setPose("land");
      burst(host, feetX(), r.top);
      btn.click();
      const back = () => { undo.delete(back); btn.click(); };
      undo.add(back); // the switch is always put back, even if the act is cut short
      await hold(500);
      setPose("scared");
      say(pick(SAY.oops));
      await hold(1500);
      setPose("hang");
      await arc(rx, ry, 26, 420);
      burst(host, feetX(), r.top);
      back();
      setPose("cheer");
      say(line("fixed"));
      await hold(900);
    } };

    // ================= On top of a page element =================
    A.stomp = { w: 3, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      const big = coin(0.55);
      if (big) { setPose("charge"); await hold(650); }
      await leap(standY(r), big, !big);
      setPose("land");
      burst(host, feetX(), r.top);
      const h = t.getBoundingClientRect().height, k = 1 - Math.min(0.12, 14 / h);
      fx(t, [{ transform: ID }, { offset: 0.25, transform: squash(k, h) }, { offset: 0.55, transform: squash(1 + (1 - k) * 0.35, h) }, { transform: ID }], 560, { easing: "ease-out" });
      if (t.matches("[data-chelik-stomp], [data-bot-stomp]")) t.click();
      await hold(340);
      setPose("cheer");
      await hold(1200);
    } };
    A.sit = { w: 2.2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.2, 0.8));
      await leap(r.top + W * (15 / 72) - vh());
      setPose("sit");
      const h = t.getBoundingClientRect().height, k = 1 - Math.min(0.05, 6 / h);
      const press = fx(t, [{ transform: ID }, { transform: squash(k, h) }], 300, { fill: "forwards", easing: "ease-out" });
      await hold(rand(2200, 3400));
      if (t.matches("[data-chelik-perch], [data-bot-perch]")) {
        setPose("tap");
        await hold(300);
        document.querySelector<HTMLElement>("[data-chelik-perch-next], [data-bot-perch-next]")?.click();
        await hold(200);
      }
      fx(t, [{ transform: squash(k, h) }, { offset: 0.5, transform: squash(1 + (1 - k), h) }, { transform: ID }], 420);
      press.cancel();
    } };
    A.shake = { w: 2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      const y = standY(r);
      await leap(y);
      setPose("cheer");
      const h = t.getBoundingClientRect().height;
      for (let i = 0; i < 4; i++) {
        const hop = move([[rx, y - rand(14, 24), 0.45], [rx, y]], 380);
        nap(330).then(() => { if (alive && !cut && !scrolled() && !grabbed) fx(t, [{ transform: ID }, { offset: 0.3, transform: `${squash(0.95, h)} rotate(${i % 2 ? 1.6 : -1.6}deg)` }, { transform: ID }], 380, { easing: "ease-out" }); });
        await hop;
      }
      await hold(500);
    } };
    A.tilt = { w: 1.6, kind: "top", fit: (r) => r.width >= 160, run: async (t) => {
      const r0 = boxOf(t);
      const right = coin();
      const r = await approach(t, (b) => b.left + b.width * (right ? rand(0.72, 0.86) : rand(0.14, 0.28)));
      const y = standY(r);
      await leap(y);
      setPose("land");
      await hold(260);
      const cx = r.left + r.width / 2;
      const th = (right ? 1 : -1) * clamp(600 / Math.max(r0.width, 1), 1.5, 4);
      const tan = Math.tan((th * Math.PI) / 180);
      setPose("hang");
      const tip = fx(t, [{ transform: ID }, { transform: `rotate(${th}deg)` }], 500, { fill: "forwards", easing: "cubic-bezier(0.3, 1.4, 0.5, 1)" });
      await move([[rx, y + (feetX() - cx) * tan]], 500, "ease-out");
      const e = txAt(right ? r.right - W * 0.15 : r.left + W * 0.15);
      await move([[e, y + (base + e + W / 2 - cx) * tan]], 700, "ease-in");
      fx(t, [{ transform: `rotate(${th}deg)` }, { offset: 0.4, transform: `rotate(${-th * 0.4}deg)` }, { offset: 0.7, transform: `rotate(${th * 0.15}deg)` }, { transform: ID }], 800);
      tip.cancel();
      await drop(right ? 28 : -28);
    } };
    A.sticker = { w: 2.2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.2, 0.8));
      await leap(standY(r));
      setPose("land");
      await hold(200);
      for (let i = 0, n = coin(0.3) ? 3 : 1; i < n; i++) {
        setPose("place");
        await hold(360);
        const now = t.getBoundingClientRect();
        stick(host, t, feetX() + (coin() ? -1 : 1) * rand(18, 46), now.top + Math.min(now.height * 0.55, rand(12, 40)));
        await hold(300);
      }
      setPose("wave");
      await hold(1100);
    } };
    A.trampoline = { w: 2.4, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      const y = standY(r);
      await leap(y);
      const h = t.getBoundingClientRect().height;
      for (let i = 0; i < 4; i++) {
        const k = 1 - Math.min(0.1, (8 + i * 3) / h);
        fx(t, [{ transform: ID }, { offset: 0.3, transform: squash(k, h) }, { offset: 0.65, transform: squash(1 + (1 - k) * 0.4, h) }, { transform: ID }], 420, { easing: "ease-out" });
        setPose(i === 3 ? "flip" : i % 2 ? "cheer" : "hang");
        await arc(rx, y, 34 + i * 34, i === 3 ? 800 : 480 + i * 80);
      }
      setPose("land");
      burst(host, feetX(), r.top);
      say(pick(SAY.yay));
      await hold(900);
    } };
    A.tightrope = { w: 2, kind: "top", fit: (r) => r.width >= 190, run: async (t) => {
      const fromLeft = coin();
      const r = await approach(t, (b) => (fromLeft ? b.left + 14 : b.right - 14));
      const y = standY(r), a = txAt(r.left + 14), b = txAt(r.right - 14);
      await leap(y);
      const to = fromLeft ? b : a, mid = (a + b) / 2 + rand(-20, 20);
      await go(mid, y, { speed: 30, pose: "balance" });
      setPose("wobble");
      say(pick(SAY.oops), 900);
      await hold(1100);
      await go(to, y, { speed: 34, pose: "balance" });
      setPose("cheer");
      await hold(900);
    } };
    A.flipit = { w: 2, kind: "top", fit: (r) => r.width < 620, run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      const y = standY(r);
      await leap(y);
      setPose("crouch");
      await hold(240);
      setPose("flip");
      const small = r.width < 240;
      fx(t, [{ transform: small ? "rotate(0deg)" : "rotateX(0deg)" }, { transform: small ? "rotate(360deg)" : "rotateX(360deg)" }], 720, { easing: "cubic-bezier(0.4, 0, 0.3, 1)" });
      await arc(rx, y, 64, 800);
      setPose("land");
      burst(host, feetX(), r.top);
      await hold(300);
      setPose("cheer");
      await hold(800);
    } };
    A.paint = { w: 2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      await leap(standY(r));
      setPose("land");
      await hold(220);
      setPose("place");
      await hold(380);
      const f = pick(PAINTS);
      const a = t.animate([{ filter: "none" }, { offset: 0.12, filter: f }, { offset: 0.85, filter: f }, { filter: "none" }], { duration: 3200, easing: "ease-in-out" });
      fxAnims.add(a);
      a.finished.catch(() => {}).finally(() => fxAnims.delete(a));
      burst(host, feetX(), r.top + 6);
      await hold(400);
      setPose("cheer");
      say(pick(SAY.yay));
      await hold(1500);
      setPose("look");
      await hold(1000);
    } };

    // ================= Hanging under a page element =================
    A.stretch = { w: 3, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.3, 0.7));
      const y = hangY(r);
      await leap(y);
      const h = t.getBoundingClientRect().height, s = Math.min(0.5, 38 / h);
      const pull = fx(t, tugs.map((k, i) => ({ offset: steps[i], transform: stretchDown(1 + k * s, h) })), 2000, { fill: "forwards", easing: "ease-in-out" });
      await move(tugs.slice(1).map((k, i) => [rx, y + h * s * k, steps[i + 1]] as Pt), 2000);
      fx(t, [{ transform: stretchDown(1 + s, h) }, { offset: 0.3, transform: "scale(1.02, 0.9)" }, { offset: 0.55, transform: "scale(0.99, 1.05)" }, { offset: 0.78, transform: "scale(1.005, 0.98)" }, { transform: ID }], 900, { easing: "ease-out" });
      pull.cancel();
    } };
    A.skew = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      await leap(hangY(r));
      setPose("swing");
      fx(t, [{ transform: ID }, { offset: 0.2, transform: "skewX(8deg)" }, { offset: 0.4, transform: "skewX(-7deg)" }, { offset: 0.6, transform: "skewX(5deg)" }, { offset: 0.8, transform: "skewX(-3deg)" }, { transform: ID }], 2000, { easing: "ease-in-out" });
      await hold(2000);
    } };
    A.squeeze = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * 0.5);
      await leap(hangY(r));
      setPose("hang");
      const g = fx(t, [{ transform: ID }, { offset: 0.35, transform: "scale(0.9, 1.05)" }, { offset: 0.55, transform: "scale(0.94, 1.03)" }, { offset: 0.75, transform: "scale(0.88, 1.06)" }, { transform: "scale(0.9, 1.05)" }], 1600, { fill: "forwards", easing: "ease-in-out" });
      await hold(1600);
      fx(t, [{ transform: "scale(0.9, 1.05)" }, { offset: 0.35, transform: "scale(1.05, 0.96)" }, { offset: 0.65, transform: "scale(0.98, 1.02)" }, { transform: ID }], 700, { easing: "ease-out" });
      g.cancel();
    } };
    A.pullright = { w: 2, kind: "bottom", fit: (r) => r.right < vw() - 130 && r.width <= 720, run: async (t) => {
      const r = await approach(t, (b) => b.right - 6);
      const y = hangY(r);
      await leap(y);
      setPose("pull");
      const w = t.getBoundingClientRect().width, s = Math.min(0.3, 80 / w);
      const pull = fx(t, tugs.map((k, i) => ({ offset: steps[i], transform: stretchRight(1 + k * s, w) })), 1800, { fill: "forwards", easing: "ease-in-out" });
      const x0 = rx;
      await move(tugs.slice(1).map((k, i) => [x0 + w * s * k, y, steps[i + 1]] as Pt), 1800);
      fx(t, [{ transform: stretchRight(1 + s, w) }, { offset: 0.3, transform: stretchRight(1 - s * 0.25, w) }, { offset: 0.6, transform: stretchRight(1 + s * 0.08, w) }, { transform: ID }], 800, { easing: "ease-out" });
      pull.cancel();
      await drop(34);
    } };
    A.monkeybars = { w: 2.2, kind: "bottom", fit: (r) => r.width >= 170, run: async (t) => {
      const fromLeft = coin();
      const r = await approach(t, (b) => (fromLeft ? b.left + 16 : b.right - 16));
      const y = hangY(r), end = txAt(fromLeft ? r.right - 16 : r.left + 16);
      await leap(y);
      const n = clamp(Math.round(Math.abs(end - rx) / 46), 3, 9), step = (end - rx) / n;
      face(step < 0);
      setPose("swing");
      for (let i = 0; i < n; i++) {
        fx(t, [{ transform: ID }, { offset: 0.5, transform: `skewX(${i % 2 ? 1.2 : -1.2}deg) translateY(1.5px)` }, { transform: ID }], 340);
        await move([[rx + step / 2, y + 7, 0.5], [rx + step, y]], 340);
      }
      setPose("hang");
      await hold(500);
    } };
    A.pullups = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.3, 0.7));
      const y = hangY(r);
      await leap(y);
      setPose("hang");
      await move([[rx, y + 12]], 300);
      for (let i = 1; i <= 3; i++) {
        fx(t, [{ transform: ID }, { offset: 0.5, transform: "translateY(3px)" }, { transform: ID }], 700, { easing: "ease-in-out" });
        await move([[rx, y - 4]], 420 + i * 80, "ease-out");
        say(`${i}`, 500);
        await move([[rx, y + 12]], 320, "ease-in");
      }
      say(line("phew"), 900);
      await hold(700);
    } };

    // ================= On the desktop: the Dock, windows and icons =================
    const byId = (id: number) => blocks().find((b) => b.id === id);
    /**
     * Windows drawn over this block: those in front of a window, every window for an icon, none for the Dock;
     * for a ledge, those in front of the window it is drawn in (every window when it is drawn on the desktop).
     */
    const frontOf = (b: WorldBlock) => {
      if (b.kind === 2) return [];
      const z = b.kind === 0 ? b.z : b.kind === 3 ? ownerZ(b) : Infinity;
      return blocks().filter((k) => k.kind === 0 && k.z < z);
    };
    /** How far back a ledge is drawn: in its window's place, behind everything on the desktop, in front of all on a menu (on -1). */
    const ownerZ = (b: WorldBlock) => (b.on === -1 ? -Infinity : b.on ? (byId(b.on)?.z ?? Infinity) : Infinity);
    /** Stretches (page x) of the block's top edge where he can stand and be seen: not under a window in front. */
    const spans = (b: WorldBlock, need = W * 1.6): [number, number][] => {
      let out: [number, number][] = [[Math.max(b.x + 6, 4), Math.min(b.x + b.w - 6, vw() - 4)]];
      for (const f of frontOf(b)) {
        if (f.y >= b.y || f.y + f.h <= b.y - H * 0.7) continue; // leaves the strip above the edge alone
        out = out.flatMap(([a, c]): [number, number][] => [[a, Math.min(c, f.x)], [Math.max(a, f.x + f.w), c]]).filter(([a, c]) => c - a > 1);
      }
      return out.filter(([a, c]) => c - a >= need);
    };
    const windowsToClimb = () => blocks().filter((b) => b.kind === 0 && b.y > H + 14 && b.y < vh() - 170 && spans(b).length > 0);
    /** His y standing on a block's top: his box dips a little below it, so his drawn soles touch the edge. The host reports visible edges. */
    const topOf = (b: WorldBlock) => b.y - vh() + W * (b.kind === 0 ? WINDOW_FOOT : b.kind === 1 ? -0.1 : FOOT);
    /** Ledges worth climbing: long enough to stand on, not too close to the top or the floor, not covered. */
    const ledgesToClimb = () => blocks().filter((b) => b.kind === 3 && b.y > H + 14 && b.y < vh() - 40 && spans(b).length > 0);
    const iconsToClimb = () => blocks().filter((b) => b.kind === 1 && b.y > H * 0.9 && b.y < vh() - 220 && b.x > 4 && b.x + b.w < vw() - 4 && spans(b, b.w - 14).length === 1);

    /**
     * Hide him behind these windows: a clip on his root showing everything but them. It is set once per change
     * (not per frame), so the GPU keeps moving his layers as before.
     */
    let clipKey = "";
    const occlude = (list: WorldBlock[]) => {
      const key = list.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join(";");
      if (key === clipKey) return;
      clipKey = key;
      const s = host.style;
      if (!list.length) { s.position = s.inset = s.pointerEvents = s.clipPath = ""; return; }
      // What stays visible, as rectangles that never overlap: cut the screen into strips at every window edge.
      const w = vw(), h = vh(), lo = -400, hi = h + 400;
      const xs = [...new Set([-400, w + 400, ...list.flatMap((b) => [b.x, b.x + b.w])])].sort((a, b) => a - b);
      let d = "";
      for (let i = 0; i + 1 < xs.length; i++) {
        const a = xs[i], c = xs[i + 1], m = (a + c) / 2;
        if (c - a < 0.5) continue;
        let y = lo;
        for (const b of list.filter((k) => k.x < m && k.x + k.w > m).sort((p, q) => p.y - q.y)) {
          if (b.y > y) d += `M${a} ${y}H${c}V${b.y}H${a}Z`;
          y = Math.max(y, b.y + b.h);
        }
        if (y < hi) d += `M${a} ${y}H${c}V${hi}H${a}Z`;
      }
      Object.assign(s, { position: "fixed", inset: "0", pointerEvents: "none", clipPath: `path("${d}")` });
    };

    /**
     * What he lands on falling from his y at page x: the nearest top below him — a window roof he can be seen on,
     * an icon, the Dock — or the floor. `from` is what he is jumping off: falling in front of it, he cannot land on
     * it or on anything behind it while he is still over it.
     */
    const below = (px: number, y0: number, from: WorldBlock | null = null): { y: number; b: WorldBlock | null } => {
      let best: { y: number; b: WorldBlock | null } = { y: 0, b: null };
      const over = (k: WorldBlock) => px >= k.x && px <= k.x + k.w;
      for (const k of blocks()) {
        const behind = (z: number) => from!.kind === 0 && z > from!.z;
        if (from && (k === from || k.id === from.id || (over(from) && (k.kind === 1 || (k.kind === 0 && behind(k.z)) || (k.kind === 3 && behind(ownerZ(k))))))) continue;
        const t = k.kind === 2 ? k.y - vh() + W * FOOT : topOf(k);
        if (t < y0 - 2 || t >= best.y) continue;
        if ((k.kind === 0 || k.kind === 3) && (k.y < H * 0.6 || !spans(k, 4).some(([a, c]) => px >= a && px <= c))) continue;
        if (k.kind !== 0 && !over(k)) continue;
        if (k.kind === 1 && !spans(k, 4).some(([a, c]) => px >= a - 4 && px <= c + 4)) continue; // an icon hidden under a window
        best = { y: t, b: k };
      }
      return best;
    };
    /** Standing on that: perched on a window or icon (hidden behind what is in front of it), up on the Dock, or on the floor. */
    const settleOn = (b: WorldBlock | null) => {
      upDock = b?.kind === 2;
      if (b && b.kind !== 2) { perchOn(b); occlude(frontOf(b)); } else { unperch(); occlude([]); }
    };
    /** Is he standing right on the window or icon he is perched on? */
    const onPerchTop = () => {
      const b = perch ? byId(perch.id) : undefined;
      return !!b && Math.abs(ry - topOf(b)) < 2.5 && rx + base + W / 2 >= b.x - 4 && rx + base + W / 2 <= b.x + b.w + 4;
    };

    const perchOn = (b: WorldBlock) => {
      perch = { id: b.id, ox: feetX() - b.x, x: b.x, y: b.y, w: b.w, h: b.h };
      rideDue = false;
      if (b.kind === 0 || (b.kind === 3 && b.on)) ctx.onPerch(true); // it can move: watch it closely
    };
    const unperch = () => {
      if (perch && byId(perch.id)?.kind !== 1) ctx.onPerch(false);
      perch = null;
      rideDue = false;
    };
    /** Landed on a block he aimed at: if it moved while he was on his way (world.changed ignores that), ride along to where it is now. */
    const perchAt = (b: WorldBlock) => {
      perchOn(b);
      const n = byId(b.id);
      if (n && (n.x !== b.x || n.y !== b.y || n.w !== b.w)) rideDue = true;
    };
    /** The block he is on his way to: if it goes away (closed, minimized, another space), he gives up. */
    let aim: number | null = null;
    world.changed = () => {
      if (aim != null && !byId(aim)) { aim = null; cut = true; }
      if (!perch) return;
      const b = byId(perch.id);
      if (!b || b.x !== perch.x || b.y !== perch.y || b.w !== perch.w) { rideDue = true; return; }
      // A window now covers all of what he stands on (say, an app went full screen): he would vanish behind it.
      if (b.kind !== 2 && spans(b, 4).length === 0) { rideDue = true; return; }
      occlude(frontOf(b)); // windows came and went in front of him
    };

    /** The window under him moved (or went away): ride along until it rests. False if he fell off. */
    const ride = async () => {
      freeze();
      clearGait();
      if (perch) perch.ox = feetX() - perch.x; // where he really is now (he may have been mid-walk)
      let quiet = 0, first = true;
      while (alive && !grabbed && perch) {
        rideDue = false;
        const b = byId(perch.id), fx0 = b ? b.x + perch.ox : 0;
        if (!b || fx0 < b.x - 4 || fx0 > b.x + b.w + 4 || b.y < H * 0.6 || (b.kind !== 2 && spans(b, 4).length === 0)) {
          unperch();
          setPose("scared");
          say(pick(SAY.oops), 900);
          await drop(0, b ?? null);
          return false;
        }
        Object.assign(perch, { x: b.x, y: b.y, w: b.w, h: b.h });
        occlude(frontOf(b));
        const nx = toX(fx0), ny = topOf(b);
        if (Math.abs(nx - rx) > 0.5 || Math.abs(ny - ry) > 0.5) {
          if (first) { first = false; setPose("hang"); say(pick(SAY.ride), 1200); }
          await glide([[nx, ny]], 110, "linear");
          quiet = 0;
        } else {
          await nap(100);
          if ((quiet += 100) >= 700) break;
        }
      }
      if (!alive || grabbed) throw ABORT;
      setPose("idle");
      return !!perch;
    };

    /** A front window's edge right next to where he stands, to hide behind: [edge x, direction into it]. */
    const hideSpot = (b: WorldBlock, cur: [number, number]): [number, number] | null => {
      for (const f of frontOf(b)) {
        if (f.y >= b.y || f.y + f.h <= b.y - H * 0.7) continue;
        if (Math.abs(f.x - cur[1]) < 2 && f.x + W * 1.6 < b.x + b.w - 6) return [f.x, 1];
        if (Math.abs(f.x + f.w - cur[0]) < 2 && f.x + f.w - W * 1.6 > b.x + 6) return [f.x + f.w, -1];
      }
      return null;
    };

    /** One small thing to do on top of a window or icon. */
    const perchMove = async (b: WorldBlock) => {
      const y = topOf(b), f = feetX();
      // Now and then a word about the app he is standing on.
      const app = ctx.senses.state.apps[String(b.kind === 0 ? b.id : b.kind === 3 ? b.on : 0)];
      if (app && coin(0.22)) say(line("app_" + app), 2200);
      const sp = spans(b, Math.min(W * 1.2, b.w - 14));
      const cur = sp.find(([a, c]) => f >= a - 3 && f <= c + 3) ?? sp[0];
      if (!cur) throw RIDE; // covered up where he stands: let ride() sort it out
      const hide = b.kind !== 1 ? hideSpot(b, cur) : null;
      const r = Math.random();
      if (hide && r < 0.4) {
        // Hide behind the window in front, then peek out.
        const [edge, dir] = hide;
        await go(toX(edge - dir * W * 0.8), y);
        await go(toX(edge + dir * W * 1.5), y, { speed: 70 });
        await hold(rand(1400, 2800));
        face(dir > 0);
        setPose("look");
        await move([[toX(edge + dir * W * 0.12), y]], 420, "ease-out");
        await hold(900);
        setPose("wave");
        await hold(900);
        await go(toX(edge - dir * W * 1.3), y, { speed: 80 });
      } else if (r < 0.62 && b.kind !== 1 && cur[1] - cur[0] > W * 3) {
        await go(toX(rand(cur[0] + W * 0.5, cur[1] - W * 0.5)), y, coin(0.25) ? { speed: 34, pose: "balance" } : {});
      } else if (r < 0.8) {
        setPose(coin() ? "sit" : "edgesit");
        await move([[rx, y + W * (15 / 72)]], 300, "ease-out");
        await hold(rand(2200, 3800));
        setPose("hang");
        await move([[rx, y - 10, 0.6], [rx, y]], 360);
        setPose("land");
        await hold(200);
      } else {
        const [p, ms] = pick([["look", 2000], ["wave", 1500], ["dance", 2400], ["stretch", 1700], ["juggle", 3000], ["nap", 3600]] as [string, number][]);
        setPose(p);
        await hold(ms);
      }
    };

    /** A few things on top; riding along whenever the window moves. False if he fell off on the way. */
    const onTop = async (n: number) => {
      for (let i = 0; i < n && perch; i++) {
        try {
          const b = byId(perch.id);
          if (!b) throw RIDE;
          await perchMove(b);
          if (perch) perch.ox = feetX() - perch.x;
        } catch (e) {
          if (e !== RIDE) throw e;
          if (!(await ride())) return false;
        }
      }
      return !!perch;
    };

    /** Jump off whatever he stands on, down to the ground (still hidden behind the windows in front). */
    const getDown = async (b: WorldBlock) => {
      unperch();
      const f = feetX(), sp = spans(b, 4), cur = sp.find(([a, c]) => f >= a - 3 && f <= c + 3);
      const r = Math.random();
      if (r < 0.3) {
        setPose("glide");
        const x = clamp(rx + rand(-120, 120), 0, maxX()), land = below(base + x + W / 2, ry, b);
        await move([[rx + 36, ry * 0.66, 0.33], [rx - 36, ry * 0.33, 0.66], [x, land.y]], clamp((land.y - ry) * 5, 1000, 3200), "linear");
        settleOn(land.b);
        setPose("land");
        await hold(300);
        return;
      }
      // Off the nearer end if it is the window's own edge, otherwise straight off the front.
      let x = rx + (facing ? -1 : 1) * rand(30, 70);
      if (cur && b.kind !== 1) {
        const left = f - cur[0] < cur[1] - f, end = left ? cur[0] : cur[1];
        if (Math.abs(end - (left ? b.x + 6 : b.x + b.w - 6)) < 2 && Math.abs(f - end) < 260) {
          await go(toX(end - (left ? -1 : 1) * W * 0.3), ry);
          x = toX(end + (left ? -1 : 1) * W * 1.3);
        }
      }
      x = clamp(x, 0, maxX());
      face(x < rx);
      setPose("crouch");
      await hold(200);
      setPose(coin(0.5) ? "flip" : "hang");
      const land = below(base + x + W / 2, ry, b);
      await arc(x, land.y, 30, clamp(460 + Math.sqrt(Math.max(1, land.y - ry)) * 22, 500, 1300));
      settleOn(land.b);
      setPose("land");
      dust(4);
      await hold(350);
    };

    /** Up onto a block's top at page x: a hop, a big jump or the jetpack, depending on how high it is. */
    const upTo = async (b: WorldBlock, px: number, jet: boolean) => {
      const top = topOf(b);
      await walkTo(toX(px) + (jet ? rand(-90, 90) : 0), { speed: RUN });
      face(px < feetX());
      if (!jet) {
        setPose("charge");
        await hold(600);
        setPose("flip");
        await arc(toX(px), top, 46, clamp(520 + (ry - top) * 0.9, 700, 1300));
      } else {
        setPose("crouch");
        await hold(240);
        setPose("jet");
        say(pick(SAY.fly), 900);
        const ms = clamp((ry - top) * 2.6, 900, 2200), tilt = toX(px) < rx ? -14 : 14;
        await Promise.all([move([[(rx + toX(px)) / 2 + rand(-40, 40), (ry + top) / 2 - 20, 0.55], [toX(px), top - 34]], ms, "cubic-bezier(0.45, 0, 0.3, 1)"), turn(tilt, 300)]);
        await Promise.all([move([[toX(px), top]], 380, "ease-out"), turn(0, 300)]);
        setRot(0);
      }
      setPose("land");
      dust(3);
      await hold(250);
    };

    /** Up the side of a window: run to it, grab it, climb up and over the corner. */
    const climbSide = async (b: WorldBlock, left: boolean) => {
      const sx = left ? b.x : b.x + b.w, out = left ? -1 : 1, top = topOf(b);
      await walkTo(toX(sx + out * W * 0.6), { speed: RUN });
      const g = ry, bottom = b.y + b.h - vh();
      face(!left);
      setPose("crouch");
      await hold(200);
      setPose("hang");
      const start = Math.min(g - 56, bottom - 24);
      await Promise.all([move([[toX(sx), start]], start < g - 80 ? 460 : 320, "ease-out"), turn(left ? -90 : 90, 320)]);
      await go(toX(sx), top + W * 0.6, { speed: 110, face: !left });
      setPose("hang");
      await Promise.all([move([[toX(sx - out * W * 0.7), top - 12, 0.6], [toX(sx - out * W * 0.7), top]], 380), turn(0, 320)]);
      setRot(0);
      setPose("land");
      await hold(220);
    };

    A.climb = { w: 3.4, ok: () => grounded() && windowsToClimb().length > 0, run: async () => {
      const all = windowsToClimb(), b = all.find((k) => k.id === favor) ?? pick(all), sp = spans(b);
      favor = null;
      aim = b.id;
      occlude(frontOf(b));
      // Climb a side when it is on screen, its corner is free and the window comes down low enough; else jump or fly.
      const sides = [true, false].filter((l) => {
        const sx = l ? b.x : b.x + b.w, end = l ? sp[0][0] : sp[sp.length - 1][1];
        const ground = vh() + gAt(toX(sx + (l ? -1 : 1) * W * 0.6));
        return (l ? sx > H + 8 : sx < vw() - H - 8) && Math.abs(end - (l ? b.x + 6 : b.x + b.w - 6)) < 2 && ground - (b.y + b.h) < 150;
      });
      if (sides.length && coin(0.75)) await climbSide(b, pick(sides));
      else {
        const s = pick(sp);
        await upTo(b, rand(s[0] + W * 0.6, s[1] - W * 0.6), vh() - b.y > 430 || coin(0.4));
      }
      aim = null;
      perchAt(b);
      setPose("cheer");
      if (coin(0.5)) say(pick(SAY.top));
      try { await hold(800); } catch (e) { if (e !== RIDE) throw e; if (!(await ride())) return; }
      if (!(await onTop(2 + Math.floor(rand(0, 3))))) return;
      await getDown(byId(b.id) ?? b);
    } };

    A.icons = { w: 2.6, ok: () => grounded() && iconsToClimb().length > 0, run: async () => {
      const list = iconsToClimb();
      let b = pick(list);
      aim = b.id;
      occlude(frontOf(b));
      await upTo(b, b.x + b.w / 2, vh() - b.y > 380 || coin(0.6));
      aim = null;
      perchOn(b);
      for (let i = 0, n = 1 + Math.floor(rand(0, 3)); i < n; i++) {
        await perchMove(b);
        // Hop over to an icon close by.
        const near = list.filter((k) => k !== b && Math.hypot(k.x - b.x, k.y - b.y) < 190);
        if (!near.length || coin(0.3)) continue;
        const k = pick(near);
        face(k.x < b.x);
        setPose("crouch");
        await hold(160);
        setPose("hang");
        await arc(toX(k.x + k.w / 2), topOf(k), 26, 520);
        setPose("land");
        b = k;
        perchOn(b);
        await hold(220);
      }
      setPose("wave");
      await hold(900);
      await getDown(b);
    } };

    A.perched = { w: 1, ok: () => onPerchTop(), run: async () => {
      const b = byId(perch!.id)!;
      occlude(frontOf(b));
      if (b.kind !== 1 && !(await onTop(1 + Math.floor(rand(0, 3))))) return;
      if (b.kind === 1) await perchMove(b);
      await getDown(byId(b.id) ?? b);
    } };

    /**
     * Up onto something he sees on screen (the top of an input box, a menu, a panel — whatever any app drew),
     * then hop from ledge to ledge for a while: up to one above, or across to one level with it.
     */
    A.ledges = { w: 3, ok: () => grounded() && ledgesToClimb().length > 0, run: async () => {
      // Rather the lower ones: a hop is more fun than a long jetpack ride every time.
      const list = ledgesToClimb().sort((p, q) => q.y - p.y);
      let b = list[Math.floor(Math.pow(Math.random(), 1.6) * list.length)];
      aim = b.id;
      occlude(frontOf(b));
      const sp = pick(spans(b));
      await upTo(b, rand(sp[0] + W * 0.5, sp[1] - W * 0.5), vh() - b.y > 380 || coin(0.35));
      aim = null;
      perchAt(b);
      if (coin(0.5)) { setPose("cheer"); say(pick(SAY.top)); try { await hold(700); } catch (e) { if (e !== RIDE) throw e; if (!(await ride())) return; } }
      for (let i = 0, n = 1 + Math.floor(rand(0, 4)); i < n && perch; i++) {
        if (!(await onTop(1))) return;
        const cur = byId(perch.id);
        if (!cur) return;
        b = cur;
        // Hop to another ledge close by, at most a bit higher than a big jump.
        const f = feetX();
        const near = ledgesToClimb().filter((k) => k.id !== b.id && b.y - k.y < 170 && k.y - b.y < 260 && spans(k).some(([a, c]) => Math.abs((a + c) / 2 - f) < 420));
        if (!near.length || coin(0.25)) continue;
        const k = pick(near), ks = spans(k), s = ks.reduce((m, q) => (Math.abs((q[0] + q[1]) / 2 - f) < Math.abs((m[0] + m[1]) / 2 - f) ? q : m));
        const px = clamp(f, s[0] + W * 0.5, s[1] - W * 0.5);
        unperch();
        aim = k.id;
        occlude(frontOf(k));
        face(px < f);
        setPose("crouch");
        await hold(180);
        setPose(coin(0.3) ? "flip" : "hang");
        await arc(toX(px), topOf(k), k.y < b.y ? 60 : 26, clamp(520 + Math.abs(k.y - b.y) * 1.2, 520, 900));
        aim = null;
        setPose("land");
        dust(2);
        perchAt(k);
        b = byId(k.id) ?? k;
        await hold(240);
      }
      if (perch) await getDown(byId(perch.id) ?? b);
    } };

    A.dock = { w: 1.2, ok: () => grounded() && !!dockSpan(), run: async () => {
      const d = dockSpan()!;
      if (!onDock()) { await runTo(rand(d.l + W, d.r - W)); await hopUp(); }
      if (coin(0.4)) await go(clamp(rx + (coin() ? -1 : 1) * rand(80, 220), d.l + W * 0.4, d.r - W * 0.4), ry);
      const g = ry;
      if (coin(0.5)) {
        setPose("edgesit");
        await move([[rx, g + W * (15 / 72)]], 320, "ease-out");
        await hold(rand(2600, 4200));
        setPose("hang");
        await move([[rx, g - 12, 0.6], [rx, g]], 420);
        setPose("land");
        await hold(250);
      } else {
        setPose(pick(["dance", "look", "juggle"]));
        await hold(2400);
      }
    } };

    // ================= Living alongside the other apps =================
    // The host tells him what happens on the computer; he reacts: looks at the app you switched to (and says
    // something about it), dances while music plays, runs to a notification, enjoys the charger, poses for a
    // screenshot, dozes off while you are away and is glad when you are back.
    const S = ctx.senses.state;
    let react: Sense | null = null;
    /** A window he means to climb next (one he was looking at). */
    let favor: number | null = null;
    const lastAt: Record<string, number> = {};
    /** Not more often than every `ms` for this kind of thing. */
    const due = (k: string, ms: number) => { const n = performance.now(); if (n - (lastAt[k] ?? -1e9) < ms) return false; lastAt[k] = n; return true; };
    const trigger = (name: string, e: Sense | null) => { if (grabbed) return; play(name); react = e; };
    ctx.senses.on = (e) => {
      switch (e.t) {
        case "apps": S.apps = e.a; break;
        case "app": if (due("app", 25000) && coin(0.55)) trigger("visit", e); break;
        case "window": if (due("window", 30000) && coin(0.45)) trigger("newwin", e); break;
        case "music":
          if (e.on === S.music) break;
          S.music = e.on;
          if (e.on && due("music", 20000)) trigger("groove", e);
          break;
        case "notify": if (due("notify", 12000) && coin(0.75)) trigger("ding", e); break;
        case "power": {
          const was = S.plugged;
          S.plugged = e.plugged;
          S.low = !e.plugged && e.level <= 15;
          if (e.plugged && e.level >= 100 && lastLevel < 100 && lastLevel > 0) trigger("full", e);
          lastLevel = e.level;
          if (was != null && was !== e.plugged) trigger(e.plugged ? "charge" : "unplug", e);
          else if (S.low && due("low", 600000)) trigger("tired", e);
          break;
        }
        case "shot": if (due("shot", 5000)) trigger("cheese", e); break;
        case "away":
          if (e.on === S.away) break;
          S.away = e.on;
          activeSince = e.on ? 0 : performance.now();
          trigger(e.on ? "snooze" : "welcome", e);
          break;
        case "typing":
          if (e.on === S.typing) break;
          S.typing = e.on;
          if (e.on && due("typing", 120000) && coin(0.5)) trigger("typer", e);
          break;
        case "copy": if (due("copy", 45000) && coin(0.35)) trigger("copied", e); break;
        case "theme": if (due("theme", 8000)) trigger("theme", e); break;
        case "net": if (due("net" + e.on, 5000)) trigger("net", e); break;
        case "quit": if (due("quit", 20000) && coin(0.5)) trigger("bye", e); break;
        case "launch": if (due("launch", 20000) && coin(0.45)) trigger("hello", e); break;
        case "space": if (due("space", 15000) && coin(0.5)) trigger("space", e); break;
        case "download": if (due("download", 10000)) trigger("download", e); break;
      }
    };
    /** On the floor (not up on a roof or the Dock): free to run somewhere. */
    const free = () => grounded() && !onDock() && !onPerchTop();
    const only = (name: string) => () => react != null && forcedNow === name;
    let forcedNow: string | null = null;
    let lastLevel = 0;
    /** Since when you have been at the computer without a break (0: away). */
    let activeSince = S.away ? 0 : performance.now(), lastBreak = performance.now();
    onPetted = () => { if (!grabbed && due("pet", 9000)) trigger("petted", null); };
    const notes = (n: number) => {
      const r = el.getBoundingClientRect();
      for (let i = 0; i < n; i++) fleck(host, "rb-note", r.left + r.width * rand(0.2, 0.8), r.top + rand(0, 10), rand(-26, 26), -rand(30, 54), 1300);
    };
    /** Look toward a spot on screen: turn to it, eyes up if it is high. */
    const lookAt = (px: number) => { face(px < feetX()); setPose("look"); };

    A.visit = { w: 0, ok: only("visit"), run: async () => {
      const e = react as Extract<Sense, { t: "app" }>;
      react = null;
      const text = line("app_" + e.c);
      if (e.x == null || e.w == null) { setPose("wave"); say(text, 2200); await hold(2000); return; }
      const px = clamp(e.x + e.w / 2 + rand(-e.w / 4, e.w / 4), 30, vw() - 30);
      if (free() && Math.abs(px - feetX()) > 60) await walkTo(toX(px), Math.abs(px - feetX()) > 400 ? { speed: RUN } : {});
      lookAt(e.x + e.w / 2);
      say(text, 2200);
      await hold(2000);
      // Sometimes he goes up to have a closer look.
      if (free() && e.id != null && coin(0.4) && windowsToClimb().some((k) => k.id === e.id)) { favor = e.id; await A.climb.run(el); }
    } };
    A.newwin = { w: 0, ok: only("newwin"), run: async () => {
      const e = react as Extract<Sense, { t: "window" }>;
      react = null;
      lookAt(e.x + e.w / 2);
      say(line("newwin"), 1800);
      await hold(1600);
      if (free() && coin(0.5) && windowsToClimb().some((k) => k.id === e.id)) { favor = e.id; await A.climb.run(el); }
    } };
    A.groove = { w: 5, ok: () => S.music || only("groove")(), run: async () => {
      if (react) { react = null; say(line("music"), 1800); }
      feel(0, 0.04);
      for (let i = 0, n = 2 + Math.floor(rand(0, 3)); i < n; i++) {
        setPose(pick(["dance", "dance", "hop", "juggle"]));
        notes(2);
        await hold(1300);
        notes(1);
        await hold(1000);
      }
    } };
    A.ding = { w: 0, ok: only("ding"), run: async () => {
      const e = react as Extract<Sense, { t: "notify" }>;
      react = null;
      const px = clamp(e.x + e.w / 2, 30, vw() - 30);
      if (free()) await runTo(toX(px));
      lookAt(px);
      setPose("hop");
      say(line("ding"), 1800);
      await hold(1300);
      setPose("look");
      await hold(1200);
    } };
    A.charge = { w: 0, ok: only("charge"), run: async () => {
      react = null;
      setPose("cheer");
      say(line("charge"), 1800);
      await hold(1700);
    } };
    A.unplug = { w: 0, ok: only("unplug"), run: async () => {
      react = null;
      setPose("scared");
      say(line("unplug"), 1800);
      await hold(1700);
    } };
    A.tired = { w: 0, ok: only("tired"), run: async () => {
      react = null;
      setPose("stretch");
      say(line("tired"), 2200);
      await hold(2000);
    } };
    A.cheese = { w: 0, ok: only("cheese"), run: async () => {
      react = null;
      setPose("wave");
      say(line("cheese"), 2000);
      await hold(1000);
      setPose("cheer");
      await hold(1000);
    } };
    A.snooze = { w: 30, ok: () => S.away || only("snooze")(), run: async () => {
      if (react) { react = null; setPose("stretch"); say(line("sleepy"), 1600); await hold(1700); }
      for (let i = 0; i < 3; i++) { setPose("nap"); if (coin(0.3)) say(line("zzz"), 1600); await hold(4200); }
    } };
    A.welcome = { w: 0, ok: only("welcome"), run: async () => {
      react = null;
      noticed(0.1);
      setPose("scared");
      await hold(450);
      setPose("wave");
      say(line("welcome"), 2000);
      await hold(1800);
    } };
    A.petted = { w: 0, ok: () => forcedNow === "petted", run: async () => {
      react = null;
      noticed(0.12);
      face(mouse.x < feetX());
      for (let i = 0; i < 2; i++) {
        setPose(i ? "laugh" : "cheer");
        hearts(2 + i);
        if (!i) say(line("pet"), 1800);
        await hold(900);
      }
    } };
    A.typer = { w: 4, ok: () => S.typing || only("typer")(), run: async () => {
      if (react) react = null;
      if (coin(0.6)) say(line("typing"), 1800);
      setPose("sit");
      await hold(2600);
      for (let i = 0; i < 3; i++) { setPose("tap"); await hold(450); setPose("sit"); await hold(500); }
    } };
    A.copied = { w: 0, ok: only("copied"), run: async () => {
      react = null;
      setPose("cheer");
      say(line("copy"), 1500);
      await hold(1400);
    } };
    // The page's theme-switch trick (above) shares this name: keep it for when no dark/light reaction is due.
    const flipSwitch = A.theme;
    A.theme = { w: flipSwitch.w, ok: () => only("theme")() || !!flipSwitch.ok?.(), run: async (t) => {
      if (react?.t !== "theme") return flipSwitch.run(t);
      const e = react as Extract<Sense, { t: "theme" }>;
      react = null;
      setPose(e.dark ? "scared" : "stretch");
      say(line(e.dark ? "dark" : "light"), 1800);
      await hold(1700);
    } };
    A.net = { w: 0, ok: only("net"), run: async () => {
      const e = react as Extract<Sense, { t: "net" }>;
      react = null;
      setPose(e.on ? "cheer" : "scared");
      say(line(e.on ? "online" : "offline"), 1900);
      await hold(1800);
    } };
    A.bye = { w: 0, ok: only("bye"), run: async () => {
      const e = react as Extract<Sense, { t: "quit" }>;
      react = null;
      setPose("wave");
      say(line("bye", e.name), 1800);
      await hold(1800);
    } };
    /** About every 50 minutes at the computer without a break: a reminder to stretch. */
    A.breather = { w: 60, ok: () => T.breaks && !!activeSince && performance.now() - activeSince > 50 * 60e3 && performance.now() - lastBreak > 50 * 60e3, run: async () => {
      lastBreak = performance.now();
      setPose("stretch");
      say(line("breather"), 2600);
      await hold(1900);
      setPose("wave");
      await hold(1200);
      setPose("stretch");
      await hold(1700);
    } };
    A.windows = { w: 0.4, ok: () => blocks().filter((b) => b.kind === 0).length >= 12, run: async () => {
      setPose("look");
      say(line("windows"), 1800);
      await hold(2200);
    } };
    /** Holidays and Friday evenings. */
    const holiday = () => {
      const d = new Date(), m = d.getMonth() + 1, day = d.getDate();
      if ((m === 12 && day === 31) || (m === 1 && day === 1)) return "newyear";
      if ((m === 12 && day >= 20) || (m === 1 && day <= 7)) return "xmas";
      if (m === 10 && day === 31) return "halloween";
      if (m === 2 && day === 14) return "valentine";
      if (d.getDay() === 5 && d.getHours() >= 15) return "friday";
      return null;
    };
    A.holiday = { w: 0.6, ok: () => !!holiday(), run: async () => {
      const k = holiday()!;
      setPose(pick(["cheer", "dance", "wave"]));
      say(line(k), 2000);
      if (k === "newyear" || k === "friday") burst(host, feetX(), feetY() - H);
      if (k === "valentine") hearts(4);
      await hold(2000);
    } };
    // The time of day.
    const hour = () => new Date().getHours();
    A.late = { w: 0.8, ok: () => hour() >= 23 || hour() < 5, run: async () => {
      setPose("stretch");
      say(line("late"), 2000);
      await hold(1800);
    } };
    A.morning = { w: 0.8, ok: () => hour() >= 6 && hour() < 10, run: async () => {
      setPose("stretch");
      say(line("morning"), 2000);
      await hold(1800);
    } };

    // ================= How he feels =================
    // Energy goes into running, flying and climbing and comes back with rest and sleep; mood rises with
    // attention (petting, treats, music, you coming back) and sinks when nobody notices him for a long time.
    // Both steer what he feels like doing, how fast he walks and what he says.
    const T = ctx.traits;
    // Fullness: each snack fills him up a bit, and it wears off by itself in about four hours.
    let energy = 0.8, mood = 0.65, full = 0.5, fullAt = Date.now(), lastAttention = performance.now(), sentMood = "";
    const DIGEST = 4 * 3600e3;
    try {
      const m = JSON.parse(window.localStorage.getItem(ctx.storageKey + ":mood") || "null");
      if (m) {
        energy = clamp(+m.e || 0.8, 0.05, 1); mood = clamp(Number.isFinite(+m.m) ? +m.m : 0.65, 0, 1);
        if (Number.isFinite(+m.f) && Number.isFinite(+m.ft)) { full = clamp(+m.f, 0, 1); fullAt = +m.ft; }
      }
    } catch { /* storage blocked */ }
    const fullness = () => clamp(full - (Date.now() - fullAt) / DIGEST, 0, 1);
    const feel = (de: number, dm: number, df = 0) => {
      energy = clamp(energy + de, 0.02, 1);
      mood = clamp(mood + dm, 0, 1);
      if (df) { full = clamp(fullness() + df, 0, 1); fullAt = Date.now(); }
      const f = fullness();
      const key = `${energy.toFixed(1)} ${mood.toFixed(1)} ${f.toFixed(1)}`;
      if (key !== sentMood) {
        sentMood = key;
        ctx.onMood({ energy, mood, full: f });
        try { window.localStorage.setItem(ctx.storageKey + ":mood", JSON.stringify({ e: energy, m: mood, f, ft: Date.now() })); } catch { /* storage blocked */ }
      }
    };
    /** Noticed: the pointer came close, he was petted, poked, fed. */
    const noticed = (dm = 0.03) => { lastAttention = performance.now(); feel(0, dm); };
    const bored = () => performance.now() - lastAttention > 8 * 60e3;
    /** Walking pace: brisk when he is lively and rested, a shuffle when tired. */
    pace = () => clamp(0.75 + 0.25 * T.activity, 0.7, 1.25) * (0.8 + 0.25 * energy);
    const night = () => { const h = new Date().getHours(); return h >= 23 || h < 6; };
    /** What an act does to him. */
    const spend = (name: string) => {
      const n = night() ? 1.4 : 1;
      if (name === "nap" || name === "snooze") feel(0.18, 0);
      else if (ENERGETIC.has(name)) feel(-0.05 * n, 0.01);
      else if (CALM.has(name)) feel(0.035, 0);
      else feel(-0.01 * n, 0);
      if (bored()) feel(0, -0.02); // nobody around to play with
      else if (mood < 0.5) feel(0, 0.01);
      if (fullness() < 0.15) feel(0, -0.01); // hungry and grumpy
    };
    ctx.onMood({ energy, mood, full: fullness() });

    // ================= Food =================
    // Food thrown in from outside (feed(), the app's cookie button) lands on the floor and stays there; throw as
    // much as you like. He runs over and eats it piece by piece until he is full. A snack he doesn't get to within
    // 5 s of landing fades away ("oops!"). Each one fills him up and gives a little energy and good mood.
    type Snack = { el: HTMLElement; x: number; ready: number; timer: number; eating?: boolean };
    let oopsAt = 0;
    const snacks: Snack[] = [];
    const FULL = 0.95;
    const dropSnack = (call = true) => {
      if (snacks.length >= 15) return; // the floor is covered already
      const c = document.createElement("div");
      c.className = "rb-cookie";
      c.textContent = pick(["🍪", "🍪", "🍪", "🍕", "🍩", "🍉", "🍦", "🧁", "🍓", "🍌"]);
      host.appendChild(c);
      const px = clamp(feetX() + (coin() ? 1 : -1) * rand(70, 420), 50, vw() - 50), floor = vh() + gAt(toX(px)) - 2;
      const t = rand(900, 1300);
      c.style.translate = `${px}px -30px`;
      c.animate([{ translate: `${px}px -30px` }, { translate: `${px}px ${floor}px`, offset: 0.8 }, { translate: `${px}px ${floor - 14}px`, offset: 0.9 }, { translate: `${px}px ${floor}px` }],
        { duration: t, easing: "ease-in", fill: "forwards" });
      const s: Snack = { el: c, x: px, ready: performance.now() + t, timer: 0 };
      s.timer = window.setTimeout(() => missed(s), t + 5000); // not eaten in time: it fades away
      snacks.push(s);
      if (call && !eating && !grabbed) play("eat");
    };
    const missed = (s: Snack) => {
      if (s.eating || !snacks.includes(s)) return;
      dropOut(s, true);
      // Missed it (not just full): a little "oops", at most every few seconds.
      if (alive && !grabbed && fullness() < FULL && performance.now() - oopsAt > 3000) { oopsAt = performance.now(); say(line("missed"), 1400); }
    };
    const dropOut = (s: Snack, fade = false) => {
      const i = snacks.indexOf(s);
      if (i < 0) return;
      snacks.splice(i, 1);
      window.clearTimeout(s.timer);
      if (fade) { s.el.style.transition = "opacity 0.6s"; s.el.style.opacity = "0"; window.setTimeout(() => s.el.remove(), 700); }
      else s.el.remove();
    };
    ctx.pantry.drop = () => dropSnack();
    let eating = false;
    A.eat = { w: 40, ok: () => snacks.length > 0 && grounded() && !onDock() && (fullness() < FULL || forced === "eat"), run: async () => {
      eating = true;
      try {
        while (snacks.length && alive) {
          if (fullness() >= FULL) {
            // Full: pat the belly and leave the rest.
            setPose("laugh");
            say(line("stuffed"), 2000);
            await hold(1800);
            break;
          }
          const s = snacks.reduce((a, b) => (Math.abs(b.x - feetX()) < Math.abs(a.x - feetX()) ? b : a));
          const wait = s.ready - performance.now();
          if (wait > 0) { setPose("look"); face(s.x < feetX()); await hold(wait); }
          const side = s.x > feetX() ? 1 : -1;
          await runTo(toX(s.x - side * W * 0.75));
          if (!snacks.includes(s)) continue; // it faded meanwhile
          s.eating = true; // it won't fade from under his nose
          face(s.x < feetX());
          setPose("crouch");
          await hold(200);
          const floor = vh() + gAt(toX(s.x)) - 2;
          for (const k of [0.7, 0.4, 0.1]) {
            setPose(coin() ? "laugh" : "crouch");
            s.el.style.scale = `${k}`;
            dust(2, s.x, floor);
            await hold(330);
          }
          dropOut(s);
          noticed(0.06);
          feel(0.05, 0, 0.16);
          if (fullness() < FULL && snacks.length) { if (coin(0.35)) say(line("yum"), 1000); continue; }
          if (fullness() >= FULL) continue; // says he is full above
          setPose("cheer");
          say(line("yum"), 1600);
          hearts(3);
          await hold(1300);
        }
      } finally {
        eating = false;
        // Interrupted mid-bite (grabbed, paused): that snack must not stay forever.
        snacks.filter((x) => x.eating).forEach((x) => dropOut(x, true));
      }
    } };
    /** A cookie falls from the sky: he runs over and eats it. (Also "Give a treat" in the app's menu.) */
    A.treat = { w: 0.3, ok: () => grounded() && !onDock() && fullness() < 0.6, run: async (t) => {
      dropSnack(false);
      await A.eat.run(t);
    } };
    /** Hungry: rubs his tummy and hints at a snack. */
    A.hungry = { w: 0.7, ok: () => fullness() < 0.2 && grounded() && !snacks.length, run: async () => {
      setPose("look");
      face(mouse.x > 0 ? mouse.x < feetX() : coin());
      say(line("hungry"), 2200);
      await hold(2000);
    } };

    A.attention = { w: 2.4, ok: () => T.follow && bored() && !S.away && mouse.x > 0 && performance.now() - mouse.t < 20000 && free(), run: async () => {
      await runTo(txAt(mouse.x));
      face(mouse.x < feetX());
      for (let i = 0; i < 2; i++) { setPose("hop"); await hold(650); }
      setPose("wave");
      say(line("attention"), 2000);
      await hold(1800);
      lastAttention = performance.now() - 6 * 60e3; // ask again in a couple of minutes if still ignored
    } };
    A.knock = { w: 0.7, run: async () => {
      setPose("look");
      await hold(500);
      say(line("knock"), 1800);
      for (let i = 0; i < 3; i++) { setPose("tap"); await hold(380); setPose("idle"); await hold(220); }
      setPose("wave");
      await hold(900);
    } };
    A.sigh = { w: 2, ok: () => mood < 0.35, run: async () => {
      setPose("sit");
      say(line(coin(0.3) ? "rain" : "sigh"), 1800);
      if (coin(0.5)) {
        // His own little rain cloud.
        const h = head(), c = prop("rb-cloud", "☁️");
        c.style.translate = `${h.x}px ${h.y - 26}px`;
        for (let i = 0; i < 10; i++) { fleck(host, "rb-drop", h.x + rand(-12, 12), h.y - 16, 0, rand(30, 50), 700); await hold(260); }
        c.remove();
      } else await hold(2800);
      if (coin(0.5)) { setPose("look"); await hold(1500); }
    } };
    A.think = { w: 1.2, ok: () => T.chatty >= 1, run: async () => {
      setPose(coin() ? "look" : "sit");
      say(line("think"), 2600);
      await hold(2800);
    } };
    A.stargaze = { w: 1.4, ok: () => night(), run: async () => {
      setPose("edgesit");
      const g = ry;
      await move([[rx, g + W * (15 / 72)]], 320, "ease-out");
      say(line("stars"), 2400);
      await hold(rand(3000, 4500));
      setPose("hang");
      await move([[rx, g - 12, 0.6], [rx, g]], 420);
      setPose("land");
      await hold(250);
    } };
    A.happyhops = { w: 1.6, ok: () => mood > 0.75 && energy > 0.35, run: async () => {
      say(line("happy"), 1800);
      for (let i = 0; i < 3; i++) {
        setPose("crouch");
        await hold(140);
        setPose(i === 2 ? "flip" : "hang");
        await arc(clamp(rx + (facing ? -1 : 1) * 26, fmin(), fmax()), ry, i === 2 ? 50 : 26, i === 2 ? 700 : 420);
        setPose("land");
        if (i === 2) hearts(3);
        await hold(160);
      }
      setPose("cheer");
      await hold(700);
    } };
    A.jacks = { w: 0.9, ok: () => energy > 0.45, run: async () => {
      say(line("jacks"), 1600);
      const n = 4 + Math.floor(rand(0, 4));
      for (let i = 1; i <= n; i++) {
        setPose("cheer");
        await arc(rx, ry, 18, 330);
        setPose("land");
        say(`${i}`, 450);
        await hold(120);
      }
      setPose("stretch");
      await hold(900);
    } };
    A.yawny = { w: 3, ok: () => energy < 0.25, run: async () => {
      setPose("stretch");
      say(line("yawny"), 1800);
      await hold(1700);
      setPose("nap");
      await hold(4200);
    } };
    /** The cursor is low and moving: he walks along under it for a bit. */
    A.tagalong = { w: 2, ok: () => T.follow && free() && mouse.x > 0 && performance.now() - mouse.t < 1500 && mouse.y > vh() - 260, run: async () => {
      if (coin(0.5)) say(line("tagalong"), 1600);
      const end = performance.now() + rand(4000, 7000);
      while (performance.now() < end) {
        const tx = txAt(mouse.x - (mouse.x > feetX() ? W : -W));
        if (Math.abs(tx - rx) > 20) await walkTo(tx, Math.abs(tx - rx) > 250 ? { speed: RUN } : {});
        else { setPose("look"); await hold(300); }
        if (performance.now() - mouse.t > 2500) break;
      }
      setPose("wave");
      await hold(700);
    } };

    // ================= More things to do =================
    /** A little thing on screen (a butterfly, a cloud): made for one act, removed when it ends. */
    const prop = (cls: string, text: string) => {
      const e = document.createElement("div");
      e.className = `rb-thing ${cls}`;
      e.textContent = text;
      host.appendChild(e);
      undo.add(() => e.remove());
      return e;
    };
    const head = () => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; };

    A.hello = { w: 0, ok: only("hello"), run: async () => {
      const e = react as Extract<Sense, { t: "launch" }>;
      react = null;
      setPose("wave");
      say(line("hello", e.name), 1900);
      await hold(1800);
    } };
    A.space = { w: 0, ok: only("space"), run: async () => {
      react = null;
      setPose("scared");
      say(line("space"), 1500);
      await turn(360, 500);
      setRot(0);
      setPose("look");
      await hold(900);
    } };
    A.download = { w: 0, ok: only("download"), run: async () => {
      react = null;
      setPose("cheer");
      say(line("download"), 1800);
      await hold(1600);
    } };
    A.full = { w: 0, ok: only("full"), run: async () => {
      react = null;
      setPose("cheer");
      say(line("full"), 1800);
      feel(0.2, 0.05);
      await hold(1600);
    } };

    /** Sinks below the bottom of the screen, waits, and pops up. */
    A.peekaboo = { w: 0.8, ok: () => free(), run: async () => {
      const g = ry;
      setPose("crouch");
      await hold(200);
      await move([[rx, g + H * 1.05]], 380, "ease-in");
      await hold(rand(1500, 3000));
      await move([[rx, g + H * 0.55]], 300, "ease-out");
      setPose("look");
      await hold(900);
      await move([[rx, g + H * 1.05]], 200, "ease-in");
      await hold(rand(700, 1400));
      setPose("cheer");
      await move([[rx, g - 30, 0.6], [rx, g]], 480, "ease-out");
      say(line("peek"), 1400);
      setPose("laugh");
      await hold(1100);
    } };
    A.kungfu = { w: 0.8, run: async () => {
      say(line("kungfu"), 1500);
      for (let i = 0; i < 4; i++) {
        face(coin());
        setPose(pick(["kick", "push", "throw", "kick"]));
        if (i === 3) await arc(rx, ry, 26, 420);
        else await hold(420);
        setPose("crouch");
        await hold(200);
      }
      setPose("cheer");
      await hold(700);
    } };
    /** Slides across the floor like on ice. */
    A.skate = { w: 0.9, ok: () => free(), run: async () => {
      const max = farEnd();
      for (let i = 0; i < 2; i++) {
        const to = clamp(rx + (rx > max / 2 ? -1 : 1) * rand(160, 320), 0, max);
        face(to < rx);
        setPose("run");
        await hold(250);
        setPose("skid");
        if (!i) say(line("skate"), 1600);
        await move([[to, ry]], Math.abs(to - rx) * 4.5, "cubic-bezier(0.2, 0.6, 0.4, 1)");
        dust(3);
      }
      setPose("cheer");
      await hold(600);
    } };
    A.bubbles = { w: 0.9, run: async () => {
      setPose("sit");
      say(line("bubbles"), 1600);
      for (let i = 0; i < 7; i++) {
        const h = head();
        fleck(host, "rb-bubble", h.x + (facing ? -10 : 10), h.y + 14, (facing ? -1 : 1) * rand(10, 60), -rand(50, 110), 1800);
        await hold(rand(260, 520));
      }
      setPose("look");
      await hold(1200);
    } };
    /** A butterfly flutters by: he chases it and maybe catches it. */
    A.butterfly = { w: 0.7, ok: () => free(), run: async () => {
      const b = prop("rb-bug", "🦋");
      const floorY = vh() + ry, start = feetX() + (coin() ? 1 : -1) * rand(150, 300);
      let bx = clamp(start, 40, vw() - 40), by = floorY - rand(90, 140);
      b.style.translate = `${bx}px ${by}px`;
      setPose("look");
      face(bx < feetX());
      say(line("butterfly"), 1500);
      await hold(700);
      const caught = coin(0.4);
      for (let i = 0; i < 4; i++) {
        const nx = clamp(bx + rand(-220, 220), 40, vw() - 40), ny = floorY - rand(i === 3 && caught ? 55 : 80, 150);
        b.animate([{ translate: `${bx}px ${by}px` }, { translate: `${(bx + nx) / 2}px ${Math.min(by, ny) - 30}px` }, { translate: `${nx}px ${ny}px` }],
          { duration: 1100, easing: "ease-in-out", fill: "forwards" });
        const flown = performance.now() + 1100;
        bx = nx; by = ny;
        await runTo(txAt(bx));
        await hold(Math.max(0, flown - performance.now()));
        face(bx < feetX());
        setPose("crouch");
        await hold(150);
        setPose("hang");
        // A grab up at it, and back down to the ground (the jump's end is up in the air).
        const g = ry;
        await arc(rx, Math.max(g - 70, by - floorY + H * 0.6), 10, 520);
        if (i === 3 && caught) break;
        setPose("fall");
        await move([[rx, g]], 260, "ease-in");
        setPose("land");
        await hold(200);
      }
      if (caught) {
        say(line("caught"), 1800);
        b.animate([{ opacity: 1 }, { opacity: 0, translate: `${bx}px ${by - 40}px` }], { duration: 900, fill: "forwards" });
        await drop();
        check();
        setPose("cheer");
        hearts(3);
      } else {
        b.animate([{ translate: `${bx}px ${by}px` }, { translate: `${bx + 200}px ${by - 300}px`, opacity: 0 }], { duration: 1400, easing: "ease-in", fill: "forwards" });
        setPose("wave");
        say(line("butterfly"), 1300);
      }
      await hold(1300);
    } };
    /** Snow in winter, petals in spring, fireflies in summer, leaves in autumn, around him. */
    const season = () => { const m = new Date().getMonth() + 1; return m === 12 || m <= 2 ? "snow" : m <= 5 ? "spring" : m <= 8 ? "summer" : "autumn"; };
    A.weather = { w: 0.5, run: async () => {
      const k = season(), cls = { snow: "rb-snow", spring: "rb-petal", summer: "rb-spark", autumn: "rb-leaf" }[k]!;
      setPose("look");
      say(line(k), 1800);
      for (let i = 0; i < 14; i++) {
        const h = head(), up = k === "summer";
        fleck(host, cls, h.x + rand(-120, 120), up ? feetY() - rand(0, 30) : h.y - rand(60, 140), rand(-30, 30), up ? -rand(60, 120) : rand(90, 160), 2200);
        await hold(rand(150, 320));
      }
      setPose(k === "snow" ? "stretch" : "dance");
      await hold(900);
    } };
    /** Dozes off standing up and jolts awake. */
    A.micronap = { w: 1, ok: () => energy < 0.5, run: async () => {
      setPose("nap");
      await hold(rand(2000, 3500));
      setPose("scared");
      await arc(rx, ry, 14, 300);
      say(line("micronap"), 1500);
      setPose("look");
      await hold(1200);
    } };
    A.conductor = { w: 2.5, ok: () => S.music, run: async () => {
      say(line("conductor"), 1600);
      for (let i = 0; i < 5; i++) {
        face(i % 2 === 0);
        setPose(i % 2 ? "wave" : "cheer");
        notes(1);
        await hold(600);
      }
      setPose("cheer");
      await hold(500);
    } };

    // ================= Gags =================
    /** Put on a hat (or shades) for one act; the old one comes back after. */
    const wear = (g: Gear) => { const old = gearNow; setGear(g); undo.add(() => setGear(old)); };
    /** Fade him (for a moment): always undone when the act ends, however it ends, so he never stays invisible. */
    const blink = (to: number, ms: number) => {
      const a = el.animate([{ opacity: 1 }, { opacity: to }], { duration: ms, fill: "forwards" });
      undo.add(() => a.cancel());
      return a;
    };

    /** Fake crash: jitters, flickers, "ERROR 404", then reboots. */
    A.glitch = { w: 0.6, run: async () => {
      say(line("glitch"), 1800);
      const j = el.animate([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ transform: `translate(${i % 2 ? 4 : -5}px, ${i % 3 ? -2 : 2}px) skewX(${i % 2 ? 12 : -9}deg)`, opacity: i % 3 ? 1 : 0.35 })),
        { duration: 900, iterations: 2, easing: "steps(8)", composite: "add" });
      undo.add(() => j.cancel());
      setPose(pick(["dizzy", "scared"]));
      await hold(1800);
      j.cancel();
      const off = blink(0, 120);
      await hold(500);
      off.cancel();
      burst(host, feetX(), feetY() - H * 0.6);
      setPose("cheer");
      say(line("jk"), 1500);
      await hold(1300);
    } };
    /** A magic trick: top hat, sparkles, a bunny pops out and hops away. */
    A.magic = { w: 0.7, ok: () => free(), run: async () => {
      wear("tophat");
      setPose("wave");
      say(line("magic"), 1800);
      await hold(1200);
      const h = head();
      for (let i = 0; i < 8; i++) fleck(host, "rb-spark", h.x + rand(-30, 30), h.y + rand(-10, 30), rand(-30, 30), -rand(20, 50), 900);
      await hold(500);
      const side = facing ? -1 : 1, bx = feetX() + side * W * 0.9, by = feetY() - 10;
      burst(host, bx, by - 10);
      const bun = prop("rb-bun", "🐰");
      bun.animate([{ translate: `${bx}px ${by}px`, scale: 0.2 }, { translate: `${bx}px ${by - 24}px`, scale: 1.2 }, { translate: `${bx}px ${by}px`, scale: 1 }],
        { duration: 500, easing: "ease-out", fill: "forwards" });
      setPose("cheer");
      say(line("rabbit"), 1800);
      await hold(1500);
      const away = bx + side * 300;
      bun.animate([0, 1, 2, 3, 4].map((i) => ({ translate: `${bx + (away - bx) * (i / 4)}px ${by - (i % 2 ? 22 : 0)}px`, opacity: i === 4 ? 0 : 1 })),
        { duration: 1400, fill: "forwards" });
      setPose("wave");
      await hold(1500);
    } };
    /** Takes a selfie. */
    A.selfie = { w: 0.7, run: async () => {
      const ph = prop("rb-phone", "📱"), place = () => { const h = head(); ph.style.translate = `${h.x + (facing ? -26 : 26)}px ${h.y + 4}px`; };
      place();
      setPose("wave");
      say(line("selfie"), 1700);
      for (const p of ["cheer", "laugh", "wave"]) {
        await hold(700);
        setPose(p);
        place();
        const h = head();
        burst(host, h.x + (facing ? -26 : 26), h.y + 4); // the flash
      }
      await hold(700);
    } };
    /** Sits down and floats up a little, calm and glowing. */
    A.meditate = { w: 0.8, ok: () => free(), run: async () => {
      const g = ry;
      setPose("sit");
      say(line("meditate"), 2200);
      await move([[rx, g - 22]], 1400, "ease-in-out");
      for (let i = 0; i < 3; i++) {
        const h = head();
        fleck(host, "rb-spark", h.x + rand(-26, 26), h.y + rand(0, 30), rand(-10, 10), -rand(20, 40), 1400);
        await move([[rx, g - 28]], 900, "ease-in-out");
        await move([[rx, g - 18]], 900, "ease-in-out");
      }
      feel(0.08, 0.03);
      await move([[rx, g]], 700, "ease-in");
      setPose("land");
      await hold(300);
    } };
    /** A drum solo. */
    A.drum = { w: 0.7, ok: () => free(), run: async () => {
      const d = prop("rb-drum", "🥁");
      d.style.translate = `${feetX() + (facing ? -W * 0.55 : W * 0.55)}px ${feetY() - 12}px`;
      say(line("drum"), 1800);
      for (let i = 0; i < 10; i++) {
        setPose(i % 2 ? "tap" : "juggle");
        if (i % 3 === 0) notes(1);
        await hold(i > 7 ? 120 : 230);
      }
      burst(host, feetX(), feetY() - H * 0.5);
      setPose("cheer");
      await hold(900);
    } };
    /** A disco ball and every colour. */
    A.disco = { w: 0.7, run: async () => {
      const h0 = head(), ball = prop("rb-disco", "🪩");
      ball.style.translate = `${h0.x}px ${h0.y - 40}px`;
      ball.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 1200, iterations: Infinity });
      const hue = el.animate([{ filter: "hue-rotate(0deg) saturate(2)" }, { filter: "hue-rotate(360deg) saturate(2)" }], { duration: 900, iterations: Infinity });
      undo.add(() => hue.cancel());
      say(line("disco"), 1800);
      for (let i = 0; i < 6; i++) {
        setPose(pick(["dance", "dance", "hop", "cheer"]));
        const h = head();
        for (let k = 0; k < 2; k++) fleck(host, "rb-spark", h.x + rand(-60, 60), h.y - 30, rand(-30, 30), rand(10, 60), 900);
        await hold(600);
      }
      hue.cancel();
    } };
    /** Sneaks along in shades, on a secret mission. */
    A.spy = { w: 0.7, ok: () => free(), run: async () => {
      wear("shades");
      say(line("spy"), 1800);
      const max = farEnd();
      for (let i = 0; i < 2; i++) {
        await go(clamp(rx + (rx > max / 2 ? -1 : 1) * rand(80, 160), 0, max), ry, { speed: 30, pose: "sneak" });
        face(!facing);
        setPose("look");
        await hold(700);
        face(!facing);
        await hold(500);
      }
      setPose("wave");
      await hold(600);
    } };
    /** Spins on his head. */
    A.breakdance = { w: 0.7, ok: () => free(), run: async () => {
      say(line("breakdance"), 1500);
      setPose("crouch");
      await hold(250);
      setPose("hang");
      await Promise.all([turn(180, 300), move([[rx, ry - H * 0.9]], 300, "ease-out")]);
      await turn(180 + 360 * 3, 1500, "linear");
      await Promise.all([turn(360 * 4, 300), move([[rx, ry + H * 0.9]], 300, "ease-in")]);
      setRot(0);
      setPose("cheer");
      dust(4);
      await hold(800);
    } };
    /** Vanishes in a puff and pops up somewhere else. */
    A.teleport = { w: 0.8, ok: () => free(), run: async () => {
      setPose("crouch");
      say(line("teleport"), 1200);
      await hold(300);
      burst(host, feetX(), feetY() - H * 0.5);
      const off = blink(0, 150);
      await hold(450);
      setPos(clamp(rand(0, farEnd()), 0, maxX()), ry);
      burst(host, feetX(), feetY() - H * 0.5);
      off.cancel();
      setPose("cheer");
      await hold(900);
    } };
    /** Hiccups. */
    A.hiccup = { w: 0.6, run: async () => {
      setPose("idle");
      for (let i = 0; i < 4; i++) {
        await hold(rand(500, 1100));
        say(line("hiccup"), 600);
        setPose("scared");
        await arc(rx, ry, 10, 220);
        setPose("idle");
      }
      setPose("laugh");
      await hold(700);
    } };

    // ================= More gags =================
    /** Where his hand is (page px), on the side he faces. */
    const hand = (dx = 0.45, dy = 0.55) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2 + (facing ? -1 : 1) * r.width * dx, y: r.top + r.height * dy }; };
    const put = (e: HTMLElement, x: number, y: number) => { e.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`; };

    A.kite = { w: 0.6, ok: () => free(), run: async () => {
      const k = prop("rb-kite", "🪁");
      say(line("kite"), 1800);
      const max = farEnd();
      for (let i = 0; i < 3; i++) {
        const to = clamp(rx + (rx > max / 2 ? -1 : 1) * rand(80, 200), 0, max);
        const fly = () => { const h = hand(); put(k, h.x + (facing ? 70 : -70), h.y - 130 - Math.sin(performance.now() / 300) * 14); };
        fly();
        const t = window.setInterval(fly, 50);
        undo.add(() => window.clearInterval(t));
        await walkTo(to, { speed: SPEED * 1.4, back: false });
        setPose("cheer");
        await hold(900);
        window.clearInterval(t);
      }
    } };
    A.raindance = { w: 0.5, ok: () => free(), run: async () => {
      say(line("raindance"), 1600);
      for (let i = 0; i < 3; i++) { setPose(i % 2 ? "hop" : "dance"); await hold(600); }
      const h = head(), c = prop("rb-cloud", "☁️");
      put(c, h.x, h.y - 70);
      for (let i = 0; i < 6; i++) { fleck(host, "rb-drop", h.x + rand(-22, 22), h.y - 58, 0, rand(60, 90), 700); await hold(180); }
      const u = prop("rb-umbrella", "☂️");
      put(u, h.x, h.y - 18);
      setPose("cheer");
      say(line("umbrella"), 1800);
      for (let i = 0; i < 12; i++) { fleck(host, "rb-drop", h.x + rand(-26, 26), h.y - 58, 0, rand(30, 40), 500); await hold(160); }
    } };
    A.fishing = { w: 0.6, ok: () => free(), run: async () => {
      const g = ry;
      setPose("edgesit");
      await move([[rx, g + W * (15 / 72)]], 320, "ease-out");
      const rod = prop("rb-rod", "🎣"), h = hand(0.5, 0.45);
      put(rod, h.x, h.y);
      say(line("fishing"), 2000);
      await hold(rand(2500, 4500));
      rod.animate([{ rotate: "0deg" }, { rotate: facing ? "18deg" : "-18deg" }, { rotate: "0deg" }], { duration: 300, iterations: 3 });
      await hold(900);
      const f = prop("rb-fish", "🐟"), fx0 = h.x + (facing ? -40 : 40);
      f.animate([{ translate: `${fx0}px ${vh() + 20}px` }, { translate: `${(fx0 + h.x) / 2}px ${h.y - 60}px` }, { translate: `${h.x}px ${h.y - 10}px` }], { duration: 700, easing: "ease-out", fill: "forwards" });
      await hold(700);
      setPose("hang");
      await move([[rx, g - 12, 0.6], [rx, g]], 420);
      setPose("cheer");
      say(line("fish"), 1800);
      await hold(1500);
    } };
    A.guitar = { w: 0.7, run: async () => {
      const gt = prop("rb-guitar", "🎸"), place = () => { const h = hand(0.15, 0.62); put(gt, h.x, h.y); };
      place();
      say(line("guitar"), 1800);
      for (let i = 0; i < 8; i++) {
        setPose(i % 2 ? "juggle" : "dance");
        place();
        notes(1);
        await hold(i > 5 ? 200 : 380);
      }
      setPose("cheer");
      await arc(rx, ry, 40, 600);
      burst(host, feetX(), feetY() - H * 0.6);
      await hold(700);
    } };
    A.ghost = { w: 0.5, run: async () => {
      const g = ry, fade = el.animate([{ opacity: 1 }, { opacity: 0.4 }], { duration: 500, fill: "forwards" });
      undo.add(() => fade.cancel());
      setPose("float");
      say(line("ghost"), 2000);
      for (let i = 0; i < 2; i++) {
        await move([[rx + 20, g - 30]], 800, "ease-in-out");
        await move([[rx - 20, g - 40]], 800, "ease-in-out");
      }
      await move([[rx, g]], 600, "ease-in");
      fade.cancel();
      setPose("laugh");
      await hold(700);
    } };
    /** Photographs the cursor. */
    A.photo = { w: 1.2, ok: () => mouse.x > 0 && performance.now() - mouse.t < 8000 && free(), run: async () => {
      face(mouse.x < feetX());
      const cam = prop("rb-cam", "📷"), h = hand(0.4, 0.4);
      put(cam, h.x, h.y);
      setPose("look");
      say(line("photo"), 1600);
      await hold(1100);
      for (let i = 0; i < 2; i++) { burst(host, mouse.x, mouse.y); await hold(400); }
      setPose("cheer");
      await hold(900);
    } };
    /** Builds something for the season: a snowman, a flower, a sand castle, a pumpkin. */
    A.build = { w: 0.6, ok: () => free(), run: async () => {
      const k = season(), what = { snow: "⛄", spring: "🌷", summer: "🏰", autumn: "🎃" }[k]!;
      const x = feetX() + (facing ? -W : W), y = feetY() - 2, b = prop("rb-build", what);
      put(b, x, y);
      b.style.scale = "0.2";
      for (const sc of [0.4, 0.65, 0.85, 1.1]) {
        setPose("crouch");
        dust(3, x, y);
        await hold(450);
        b.style.scale = `${sc}`;
        setPose("land");
        await hold(300);
      }
      setPose("cheer");
      say(line("build_" + k), 1900);
      await hold(1600);
      setPose("look");
      await hold(900);
    } };
    /** Blows a bubblegum bubble until it pops on his face. */
    A.bubblegum = { w: 0.6, run: async () => {
      say(line("gum"), 1300);
      setPose("idle");
      await hold(1200);
      const gm = prop("rb-gum", ""), h = head(), x = h.x + (facing ? -6 : 6), y = h.y + H * 0.24;
      put(gm, x, y);
      gm.animate([{ scale: 0.1 }, { scale: 1.8 }], { duration: 1800, easing: "ease-in", fill: "forwards" });
      await hold(1800);
      gm.remove();
      burst(host, x, y);
      setPose("scared");
      say(line("pop"), 1500);
      await hold(1300);
      setPose("laugh");
      await hold(600);
    } };
    /** A coffee, then the zoomies. */
    A.coffee = { w: 0.6, ok: () => free(), run: async () => {
      const cup = prop("rb-cup", "☕"), place = () => { const h = hand(0.4, 0.42); put(cup, h.x, h.y); };
      place();
      setPose("look");
      say(line("coffee"), 1500);
      await hold(1600);
      cup.remove();
      setPose("scared");
      await arc(rx, ry, 30, 380);
      say(line("zoomies"), 1600);
      feel(0.25, 0.05);
      const max = farEnd();
      for (let i = 0; i < 4; i++) {
        await runTo(i % 2 ? rand(0, max * 0.25) : rand(max * 0.75, max), { speed: RUN * 2 });
        setPose("skid");
        dust(5);
        await hold(150);
      }
      setPose("dizzy");
      await hold(1000);
    } };
    /** Slips on a banana peel. */
    A.banana = { w: 0.5, ok: () => free(), run: async () => {
      const max = farEnd(), dir = rx > max / 2 ? -1 : 1, at = clamp(rx + dir * rand(140, 260), 0, max);
      const pe = prop("rb-peel", "🍌"), px = base + at + W / 2, py = feetY() - 8;
      put(pe, px, py);
      await walkTo(at - dir * W * 0.2);
      setPose("trip");
      say(line("banana"), 1500);
      pe.animate([{ translate: `${px}px ${py}px` }, { translate: `${px + dir * 120}px ${py - 60}px`, rotate: "540deg", opacity: 0 }], { duration: 700, fill: "forwards" });
      await Promise.all([turn(dir * -80, 260), move([[clamp(rx + dir * 26, 0, maxX()), ry - 20, 0.5], [clamp(rx + dir * 40, 0, maxX()), ry]], 420)]);
      dust(5);
      setPose("dizzy");
      await hold(1100);
      await turn(0, 300);
      setPose("land");
      await hold(500);
    } };
    /** Walks in his sleep and wakes up somewhere else. */
    A.sleepwalk = { w: 0.6, ok: () => free() && (energy < 0.55 || night()), run: async () => {
      say(line("sleepwalk"), 2200);
      const max = farEnd();
      await go(clamp(rx + (rx > max / 2 ? -1 : 1) * rand(120, 240), 0, max), ry, { speed: 20, pose: "sneak" });
      setPose("scared");
      await arc(rx, ry, 16, 300);
      say(line("wakeup"), 1600);
      setPose("look");
      await hold(1300);
    } };

    // ---- Choosing what to do next: the less an act has been seen (ever, and lately), the likelier it is.
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(window.localStorage.getItem(ctx.storageKey) || "{}") || {}; } catch { /* storage blocked */ }
    let saveTimer = 0;
    const save = () => {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
      try { window.localStorage.setItem(ctx.storageKey, JSON.stringify(seen)); } catch { /* storage blocked */ }
    };
    const recent: string[] = [];
    let forced: string | null = null;
    let lastTarget: HTMLElement | null = null;
    const play = (name?: string) => {
      if (name && A[name]) {
        forced = name;
        react = null; // an event waiting for its reaction is dropped (trigger() sets the new one right after)
        // Cut the current act short (it tidies up as usual) so the request feels immediate.
        cut = true;
        wake?.();
      }
      return Object.keys(A);
    };
    ctx.expose(play);

    const next = async () => {
      cut = false;
      // His window moved between acts: ride along instead of falling off in recover().
      if (rideDue && perch && alive && !grabbed) await ride();
      check();
      // Asked for a trick while up on a roof: get down first (maybe onto another roof, so a few times at most).
      forcedNow = forced;
      for (let i = 0; i < 3 && forced && forced !== "perched" && !ANYWHERE.has(forced) && A[forced] && onPerchTop(); i++) await getDown(byId(perch!.id)!);
      // Asked for a trick that needs the floor while up on the Dock: hop down first.
      if (forced && A[forced] && onDock() && !ON_DOCK.has(forced) && !ANYWHERE.has(forced)) {
        const d = dockSpan()!;
        await walkTo(rx - d.l < d.r - rx ? d.l - W : d.r + W, { speed: RUN });
      }
      const lists = { top: candidates("top"), bottom: candidates("bottom") };
      const opts: [string, number, HTMLElement[]][] = [];
      const docked = onDock(), roofed = onPerchTop();
      for (const [name, a] of Object.entries(A)) {
        const list = a.kind ? lists[a.kind].filter((t) => !a.fit || a.fit(boxOf(t))) : [];
        if ((a.kind && !list.length) || (a.ok && !a.ok())) continue;
        if (docked && !ON_DOCK.has(name) && !ANYWHERE.has(name)) continue; // up on the Dock: only what fits there
        if (roofed !== (name === "perched") && !ANYWHERE.has(name)) continue; // on a roof: carry on up there; "perched" only then
        const i = recent.indexOf(name);
        let w = (a.kind ? a.w * 1.5 : a.w) / (1 + (seen[name] ?? 0) * 0.8);
        if (i >= 0) w *= i < 6 ? 0.03 : 0.3;
        if (S.music && (name === "dance" || name === "sing")) w *= 4; // music on: he is in the mood
        // Character and feelings: lively acts when he is active and rested, calm ones when not.
        if (ENERGETIC.has(name)) w *= T.activity * (0.25 + energy);
        else if (CALM.has(name)) w *= (1.7 - energy) / T.activity;
        if ((name === "nap" || name === "yawn") && T.nightSleep && night()) w *= 4;
        if (name === "think" && T.chatty >= 2) w *= 2.5;
        if (S.away && name !== "snooze") w *= 0.05; // nobody around: mostly dozing
        if (S.low && (name === "nap" || name === "yawn")) w *= 3;
        if (name === "eat") w = 1e6; // food on the floor and still hungry (its ok() checks both): that comes first
        if (name === forced) w = 1e9;
        opts.push([name, w, list]);
      }
      forced = null;
      forcedNow = null;
      let roll = Math.random() * opts.reduce((s, o) => s + o[1], 0);
      const [name, , list] = opts.find((o) => (roll -= o[1]) <= 0) ?? opts[0];
      recent.unshift(name);
      recent.length = Math.min(recent.length, 14);
      seen[name] = (seen[name] ?? 0) + 1;
      if (!saveTimer) saveTimer = window.setTimeout(save, 30000); // a write to storage is not free: batch them
      let t: HTMLElement = el;
      if (list.length) {
        t = pick(list);
        if (t === lastTarget && list.length > 1) t = list.find((c) => c !== lastTarget) ?? t;
        lastTarget = t;
        watch.start = scroller.scrollTop;
        watch.on = true;
      }
      ctx.onAct(name);
      spend(name);
      try {
        await A[name].run(t);
      } catch (e) {
        // An act with no ride handling of its own (a reaction up on a roof, say): ride along rather than fall.
        if (e !== RIDE || !perch || !alive || grabbed) throw e;
        await ride();
      }
    };

    const run = async () => {
      await nap(900);
      let first = ctx.greet;
      while (alive) {
        measure();
        try {
          if (first) { first = false; setPose("wave"); say(pick(SAY.hi)); await hold(1800); }
          else await next();
        } catch (e) {
          if (e !== ABORT && e !== RIDE) { console.error(e); await nap(1000); } // never spin on a broken act
        }
        await recover();
        if (alive && !grabbed) {
          setPose("idle");
          if (!cut) await new Promise<void>((res) => { wake = res; nap(rand(150, 800) * (T.activity < 0.8 ? 3.5 : T.activity > 1.4 ? 0.45 : 1) * (energy < 0.3 ? 1.8 : 1)).then(res); });
          wake = null;
        }
      }
    };
    run();

    return () => {
      alive = false;
      // Paused or hidden mid-act: take away what the act put on screen (food, props, fades) right now.
      [...undo].forEach((f) => f());
      undo.clear();
      [...snacks].forEach((s) => dropOut(s));
      ctx.pantry.drop = undefined;
      cancelFx();
      timers.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(bubbleTimer);
      window.clearTimeout(lookTimer);
      if (saveTimer) save();
      mouse.wake = undefined;
      freeze(); // keep the spot he had reached mid-walk or mid-flight
      hush();
      scrollSrc.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onMouse);
      hit.removeEventListener("pointermove", onMouse);
      hit.removeEventListener("pointerdown", onDown);
      hit.removeEventListener("pointermove", onDrag);
      hit.removeEventListener("pointerup", onUp);
      hit.removeEventListener("pointercancel", onUp);
      hit.removeEventListener("lostpointercapture", onUp);
      cancelFx();
      [...undo].forEach((f) => f());
      if (over) ctx.onInteractive(false);
      // Leave him standing on the floor, upright, so the next run starts clean.
      el.classList.remove("held");
      el.style.transformOrigin = "";
      clearGait();
      setRot(0);
      setScl(1);
      setPos(clamp(rx, 0, Math.max(0, maxX())), 0);
      unperch();
      occlude([]);
      world.changed = undefined;
      ctx.senses.on = undefined;
      setPose("idle");
    };
  }
}
