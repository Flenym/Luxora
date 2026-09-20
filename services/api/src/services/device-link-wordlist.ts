/**
 * Short authentication string wordlist (IDENTITY_ACCESS §10.1.5).
 *
 * Both endpoints of a device-link approval display four words derived from
 * the approved transcript. The words are a relay warning for the humans
 * comparing screens, not a cryptographic secret (32 bits). Requirements for
 * this list: exactly 256 common short English words, lowercase ASCII,
 * no profanity, no duplicates, pairwise distinct enough to read aloud.
 */
export const DEVICE_LINK_SAS_WORDS: readonly string[] = Object.freeze([
  "amber", "anchor", "angel", "apple", "apron", "archer", "arctic", "armor",
  "arrow", "ashen", "atlas", "autumn", "baker", "bamboo", "banjo", "barley",
  "basin", "basket", "beacon", "beaver", "birch", "bison", "blade", "blanket",
  "blossom", "brave", "breeze", "bridge", "bright", "bronze", "brook", "bundle",
  "cabin", "cactus", "camel", "candle", "canvas", "canyon", "caravan", "carbon",
  "carrier", "cedar", "chain", "cherry", "chime", "cinder", "citrus", "clover",
  "cobalt", "comet", "compass", "copper", "coral", "cottage", "cotton", "cougar",
  "crane", "crimson", "crown", "crystal", "curious", "daisy", "dancer", "dawn",
  "delta", "desert", "dolphin", "donkey", "dragon", "drift", "drum", "dune",
  "eagle", "ember", "emerald", "engine", "falcon", "farmer", "feather", "fern",
  "fiber", "field", "flame", "flint", "forest", "forge", "fossil", "fountain",
  "frost", "garlic", "ginger", "glacier", "glove", "granite", "grape", "grove",
  "hammer", "harbor", "harvest", "hazel", "heron", "honey", "horizon", "hybrid",
  "ivory", "jacket", "jaguar", "jasper", "jungle", "juniper", "kettle", "kite",
  "koala", "lantern", "larch", "laser", "launch", "leaf", "lemon", "linen",
  "lizard", "llama", "lunar", "magnet", "mango", "maple", "marble", "meadow",
  "melon", "mercury", "miller", "mint", "mirror", "monarch", "moss", "mountain",
  "nectar", "needle", "noble", "north", "nugget", "oasis", "ocean", "onyx",
  "opal", "orbit", "orchard", "otter", "oyster", "panda", "paper", "pasture",
  "pebble", "pencil", "pepper", "petal", "pilot", "pine", "pioneer", "plains",
  "planet", "plaza", "poplar", "prairie", "prism", "puma", "quartz", "quiver",
  "radar", "raven", "river", "robin", "rocket", "ridge", "saddle", "saffron",
  "salmon", "sapphire", "savanna", "scarlet", "sculpt", "sender", "shadow",
  "sheriff", "silver", "slate", "solar", "spark", "spruce", "summit", "sunny",
  "tango", "tiger", "timber", "topaz", "trail", "tulip", "tundra", "turbo",
  "umber", "unicorn", "valley", "velvet", "victor", "violet", "violin", "walnut",
  "wander", "willow", "window", "wisdom", "wizard", "wolf", "yonder", "zebra",
  "zephyr", "acorn", "aloe", "antler", "aster", "badger", "baobab", "bluff",
  "brisk", "crag", "cliff", "cumin", "dingo", "egret", "elm", "fjord",
  "fable", "finch", "gecko", "grotto", "herb", "ibex", "ink", "iris",
  "jackal", "kelp", "lotus", "lynx", "magpie", "newt", "oar", "ouzel",
  "pollen", "quail", "reed", "sage", "thyme", "wren", "yew", "zinnia", "alder"
]);

if (DEVICE_LINK_SAS_WORDS.length !== 256) {
  throw new Error("Device link SAS wordlist must contain exactly 256 words");
}
if (new Set(DEVICE_LINK_SAS_WORDS).size !== 256) {
  throw new Error("Device link SAS wordlist must not contain duplicates");
}
