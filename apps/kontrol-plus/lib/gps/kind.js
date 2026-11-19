// Тип юніта GPS за назвою з Wialon. Назви пишуть вільно: «AA1234BB_DAF XF», «BC5678CE..John Deere 8R», «МТЗ-82 (Іваненко)»,
// кирилицею і латиною, з роздільниками «_», «..», «-», «/», «.», у різному регістрі, із змішаними літерами в номерах.
// guessKind(name) → 'truck' | 'tractor' | 'special' | 'van' | 'other' | null (null — не вдалося визначити).
// Це лише підказка: ручний тип (kind_manual) sync не перезаписує.

export const KINDS = ['truck', 'tractor', 'special', 'van', 'other'];

export const KIND_LABELS = {
    truck: 'Вантажівка / тягач',
    tractor: 'Трактор',
    special: 'Спецтехніка / комбайн',
    van: 'Бус / фургон',
    other: 'Інше',
};

// Кириличні літери, схожі на латинські: у назвах їх плутають («МАN», «Ѕcania»), тож порівнюємо ще й у латиниці.
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ё: 'e' };

// Нормалізація: нижній регістр, роздільники («_», «..», «-», «/», дужки…) → пробіл, апострофи прибрані.
export function normalizeUnitName(name) {
    return String(name == null ? '' : name)
        .toLowerCase()
        .replace(/[ʼ'’`]/g, '')
        .replace(/\.{2,}/g, ' ')
        .replace(/[_./\\|,;:()[\]{}+*#№"«»–—-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function latinize(text) {
    return text.replace(/[авекмнортухіїё]/g, (ch) => LOOKALIKE[ch] || ch);
}

// Український номер (2 літери + 4 цифри + 2 літери, у будь-якій розкладці) з назви прибираємо — він не несе типу.
const PLATE_RE = /(?<![\p{L}\d])[\p{L}]{2} ?\d{4} ?[\p{L}]{2}(?![\p{L}\d])/gu;

// Кириличний шаблон: межі слова — через Unicode (у JS \b для кирилиці не працює); \b у джерелі = кінець слова.
function cy(re) {
    return new RegExp('(?<![\\p{L}\\d])(?:' + re.source.replace(/\\b/g, '(?![\\p{L}\\d])') + ')', 'u');
}

// Правила йдуть по порядку, перший збіг виграє: спецтехніка → трактор → бус → вантажівка → інше.
// lat — по латинізованому тексту (кирилічні двійники літер замінені), cyr — по оригіналу.
const RULES = [
    {
        kind: 'special',
        cyr: cy(/комбайн|екскаватор|навантажувач|погрузчик|бульдозер|грейдер|автокран|кран\b|каток|маніпулятор|асфальт|бетонозмішувач|бетономешалка|обприскувач|опрыскиватель|жатка|евакуатор|автовишка|лексіон|лексион|такано|катана/),
        lat: /\b(combine|harvester|excavator|loader|bulldozer|grader|telehandler|manitou|jcb|bobcat|caterpillar|komatsu|liebherr|hitachi|doosan|lexion|tucano|dominator|trion|jaguar|axial ?flow|sprayer|rogator|katana|big ?x|holmer|tigra|vector ?\d+|cx ?\d+|new ?holland ?(cx|cr|tc)\d*|case ?(cx|cr)\d*|[sw][5-9]\d{2})\b/,
    },
    {
        kind: 'tractor',
        cyr: cy(/трактор|мтз|юмз|хтз|лтз|беларус|белорус|кіровець|кировец|к 7\d\d|т 150|т 40|т 25|джон дір|джон дир|нью холланд|нью холанд|кейс|клаас|класс|фендт|массей|мессі/),
        lat: /\b(tractor|john ?deere|deere|jd|\d ?r ?\d{0,3}|new ?holland|nh|fendt|claas|axion|arion|xerion|case ?ih|case|optum|steiger|quadtrac|farmall|maxxum|versatile|valtra|massey|zetor|challenger|kubota|landini|deutz|fahr|mccormick|belarus|mtz|yumz|htz|ltz|kirovets|t ?150|k ?7\d\d)\b/,
    },
    {
        kind: 'van',
        cyr: cy(/бус\b|мікроавтобус|микроавтобус|фургон|газел|спринтер|транзит|крафтер|дукато|боксер\b|маршрутк|вито\b|віто\b|кадді|берлінго|партнер\b|джампер|джампі|експерт\b|віваро/),
        lat: /\b(van|bus|minibus|sprinter|transit|crafter|ducato|boxer|master|movano|vivaro|trafic|vito|viano|caddy|partner|berlingo|kangoo|doblo|jumper|jumpy|expert|daily|gazelle|gazel|sollers|maxus|transporter|proace|scudo|dispatch|hiace|porter|nemo|bipper|fiorino|citan)\b/,
    },
    {
        kind: 'truck',
        cyr: cy(/тягач|сідельн|седельн|самоскид|самосвал|вантажівк|грузовик|вантажн|грузов|бортов|цистерн|бензовоз|паливозаправ|зерновоз|тент\b|реф\b|рефриж|фура|фури|контейнеровоз|лісовоз|кормовоз|міксер|камаз|маз\b|краз|урал|зіл\b|зил\b|газон|татра|ман\b|даф\b|скания|скан\b|вольво|рено|ивеко|івеко|актрос|арокс|кенворт|пітербілт|фрейтлайнер|ситрак|шакман|хово|фав\b|кантер/),
        lat: /\b(truck|semi|tipper|dumper|tanker|lorry|daf|man|tgx|tgs|tgl|tgm|scania|volvo|fh ?\d{0,3}|fm ?\d{0,3}|fmx|vnl|actros|arocs|atego|axor|antos|econic|iveco|stralis|trakker|eurocargo|renault|magnum|premium|midlum|kerax|kamaz|maz|kraz|ural|zil|gazon|tatra|freightliner|kenworth|peterbilt|mack|sitrak|shacman|howo|foton|faw|isuzu|canter|fuso|hino|xf ?\d{0,3}|cf ?\d{0,3})\b/,
    },
    {
        kind: 'other',
        cyr: cy(/причіп|прицеп|напівпричіп|полуприцеп|п п|легков|седан|кросовер|мотоцикл|скутер|квадроцикл|генератор|контейнер\b|кунг/),
        lat: /\b(trailer|semitrailer|schmitz|krone|kogel|wielton|tirsan|bodex|fliegl|passat|octavia|skoda|toyota|camry|rav4|corolla|hilux|kia|sportage|honda|mazda|nissan|bmw|audi|lexus|lanos|logan|duster|sandero|lada|vaz|motorcycle|scooter|quad|atv|car|sedan|suv|pickup)\b/,
    },
];

export function guessKind(name) {
    const text = normalizeUnitName(name).replace(PLATE_RE, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const lat = latinize(text);
    // Комбайни John Deere (S / W-серії) — спецтехніка, а не трактор, навіть з назвою бренду.
    if (/\b(jd|deere|john ?deere) ?[sw] ?[5-9]\d{2}\b/.test(lat)) return 'special';
    for (const rule of RULES) {
        if (rule.cyr.test(text) || rule.lat.test(lat)) return rule.kind;
    }
    return null;
}

export function isKind(value) {
    return KINDS.includes(value);
}
