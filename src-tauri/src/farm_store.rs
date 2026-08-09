use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

// ── Crop definitions ──────────────────────────────────────────────────────────

pub struct CropDef {
    pub id: &'static str,
    pub name_cn: &'static str,
    pub color: &'static str,         // tile accent color (hex)
    pub seed_cost: u64,
    pub grow_secs: u64,
    pub base_yield: u64,
    pub sell_per_unit: u64,
    pub seasons: u8,
}

pub const CROPS: &[CropDef] = &[
    // ── Tier 1: Quick (30m-2h) ──────────────────────────────────────
    CropDef { id:"spinach",     name_cn:"菠菜",   color:"#3A8C20", seed_cost:5,   grow_secs:1_800,   base_yield:5,  sell_per_unit:1,  seasons:1 },
    CropDef { id:"lettuce",     name_cn:"生菜",   color:"#78CC40", seed_cost:6,   grow_secs:2_400,   base_yield:5,  sell_per_unit:1,  seasons:1 },
    CropDef { id:"wheat",       name_cn:"小麦",   color:"#E8C840", seed_cost:8,   grow_secs:3_000,   base_yield:6,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"radish",      name_cn:"白萝卜", color:"#F0B0D8", seed_cost:8,   grow_secs:3_600,   base_yield:6,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"onion",       name_cn:"洋葱",   color:"#C8804A", seed_cost:10,  grow_secs:5_400,   base_yield:7,  sell_per_unit:2,  seasons:1 },
    // ── Tier 2: Short-Medium (2h-6h) ────────────────────────────────
    CropDef { id:"garlic",      name_cn:"大蒜",   color:"#F0ECE0", seed_cost:10,  grow_secs:7_200,   base_yield:7,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"carrot",      name_cn:"胡萝卜", color:"#F5A623", seed_cost:12,  grow_secs:7_200,   base_yield:8,  sell_per_unit:3,  seasons:1 },
    CropDef { id:"green_bean",  name_cn:"四季豆", color:"#5CC840", seed_cost:14,  grow_secs:9_000,   base_yield:8,  sell_per_unit:3,  seasons:1 },
    CropDef { id:"leek",        name_cn:"韭菜",   color:"#3A7820", seed_cost:16,  grow_secs:10_800,  base_yield:9,  sell_per_unit:3,  seasons:1 },
    CropDef { id:"potato",      name_cn:"土豆",   color:"#C8A96A", seed_cost:18,  grow_secs:10_800,  base_yield:10, sell_per_unit:4,  seasons:1 },
    // ── Tier 3: Medium (6h-16h) ─────────────────────────────────────
    CropDef { id:"sweet_potato",name_cn:"红薯",   color:"#C86840", seed_cost:20,  grow_secs:14_400,  base_yield:10, sell_per_unit:4,  seasons:1 },
    CropDef { id:"cucumber",    name_cn:"黄瓜",   color:"#58C040", seed_cost:22,  grow_secs:14_400,  base_yield:11, sell_per_unit:5,  seasons:1 },
    CropDef { id:"corn",        name_cn:"玉米",   color:"#F5D020", seed_cost:25,  grow_secs:14_400,  base_yield:12, sell_per_unit:5,  seasons:1 },
    CropDef { id:"pepper",      name_cn:"辣椒",   color:"#E84020", seed_cost:28,  grow_secs:18_000,  base_yield:12, sell_per_unit:6,  seasons:1 },
    CropDef { id:"asparagus",   name_cn:"芦笋",   color:"#4CA840", seed_cost:32,  grow_secs:21_600,  base_yield:13, sell_per_unit:6,  seasons:1 },
    CropDef { id:"tomato",      name_cn:"西红柿", color:"#E05050", seed_cost:35,  grow_secs:21_600,  base_yield:14, sell_per_unit:7,  seasons:1 },
    CropDef { id:"broccoli",    name_cn:"西兰花", color:"#2A7820", seed_cost:35,  grow_secs:21_600,  base_yield:14, sell_per_unit:7,  seasons:1 },
    CropDef { id:"cauliflower", name_cn:"花椰菜", color:"#E8E8D8", seed_cost:40,  grow_secs:25_200,  base_yield:15, sell_per_unit:8,  seasons:1 },
    CropDef { id:"cabbage",     name_cn:"圆白菜", color:"#A8D060", seed_cost:44,  grow_secs:28_800,  base_yield:16, sell_per_unit:8,  seasons:1 },
    CropDef { id:"eggplant",    name_cn:"茄子",   color:"#8B5CF6", seed_cost:45,  grow_secs:28_800,  base_yield:16, sell_per_unit:8,  seasons:1 },
    // ── Tier 4: Long (16h-24h) ──────────────────────────────────────
    CropDef { id:"cotton",      name_cn:"棉花",   color:"#F0F0F8", seed_cost:55,  grow_secs:36_000,  base_yield:18, sell_per_unit:9,  seasons:1 },
    CropDef { id:"sunflower",   name_cn:"向日葵", color:"#FDD835", seed_cost:60,  grow_secs:43_200,  base_yield:20, sell_per_unit:10, seasons:1 },
    CropDef { id:"pumpkin",     name_cn:"南瓜",   color:"#F07820", seed_cost:60,  grow_secs:43_200,  base_yield:20, sell_per_unit:10, seasons:1 },
    CropDef { id:"melon",       name_cn:"哈密瓜", color:"#D4B840", seed_cost:65,  grow_secs:50_400,  base_yield:20, sell_per_unit:11, seasons:1 },
    CropDef { id:"blueberry",   name_cn:"蓝莓",   color:"#5060D0", seed_cost:70,  grow_secs:50_400,  base_yield:22, sell_per_unit:11, seasons:2 },
    CropDef { id:"cantaloupe",  name_cn:"香瓜",   color:"#E8C840", seed_cost:75,  grow_secs:57_600,  base_yield:23, sell_per_unit:12, seasons:1 },
    CropDef { id:"strawberry",  name_cn:"草莓",   color:"#E8507A", seed_cost:80,  grow_secs:57_600,  base_yield:24, sell_per_unit:12, seasons:2 },
    CropDef { id:"cherry",      name_cn:"樱桃",   color:"#C82040", seed_cost:90,  grow_secs:64_800,  base_yield:26, sell_per_unit:13, seasons:2 },
    CropDef { id:"peach",       name_cn:"桃子",   color:"#F0A080", seed_cost:95,  grow_secs:72_000,  base_yield:28, sell_per_unit:14, seasons:2 },
    CropDef { id:"watermelon",  name_cn:"西瓜",   color:"#4CAF50", seed_cost:110, grow_secs:86_400,  base_yield:30, sell_per_unit:15, seasons:2 },
    CropDef { id:"peanut",      name_cn:"花生",   color:"#D4A060", seed_cost:115, grow_secs:86_400,  base_yield:30, sell_per_unit:15, seasons:1 },
    CropDef { id:"mushroom",    name_cn:"蘑菇",   color:"#E06040", seed_cost:120, grow_secs:108_000, base_yield:32, sell_per_unit:16, seasons:3 },
    // ── Tier 5: Multi-season (1-3 days) ─────────────────────────────
    CropDef { id:"lychee",      name_cn:"荔枝",   color:"#E84070", seed_cost:120, grow_secs:93_600,  base_yield:32, sell_per_unit:16, seasons:2 },
    CropDef { id:"orange",      name_cn:"橙子",   color:"#F58010", seed_cost:130, grow_secs:108_000, base_yield:32, sell_per_unit:17, seasons:2 },
    CropDef { id:"pear",        name_cn:"梨子",   color:"#C8D858", seed_cost:140, grow_secs:115_200, base_yield:34, sell_per_unit:18, seasons:2 },
    CropDef { id:"apple",       name_cn:"苹果",   color:"#E03020", seed_cost:150, grow_secs:129_600, base_yield:36, sell_per_unit:19, seasons:2 },
    CropDef { id:"pomegranate", name_cn:"石榴",   color:"#C82040", seed_cost:155, grow_secs:144_000, base_yield:38, sell_per_unit:20, seasons:2 },
    CropDef { id:"grape",       name_cn:"葡萄",   color:"#7B68EE", seed_cost:160, grow_secs:172_800, base_yield:40, sell_per_unit:22, seasons:3 },
    CropDef { id:"longan",      name_cn:"龙眼",   color:"#D4A840", seed_cost:170, grow_secs:172_800, base_yield:40, sell_per_unit:22, seasons:2 },
    CropDef { id:"mango",       name_cn:"芒果",   color:"#F09820", seed_cost:180, grow_secs:187_200, base_yield:42, sell_per_unit:24, seasons:2 },
    CropDef { id:"pineapple",   name_cn:"菠萝",   color:"#F0C020", seed_cost:200, grow_secs:216_000, base_yield:45, sell_per_unit:26, seasons:2 },
    CropDef { id:"banana",      name_cn:"香蕉",   color:"#F5D820", seed_cost:210, grow_secs:230_400, base_yield:48, sell_per_unit:28, seasons:2 },
    // ── Tier 6: Rare/Exotic (3-7 days) ──────────────────────────────
    CropDef { id:"coconut",      name_cn:"椰子",   color:"#8B5A20", seed_cost:240, grow_secs:259_200, base_yield:50, sell_per_unit:30, seasons:2 },
    CropDef { id:"dragon_fruit", name_cn:"火龙果", color:"#E83068", seed_cost:280, grow_secs:302_400, base_yield:55, sell_per_unit:35, seasons:3 },
    CropDef { id:"starfruit",    name_cn:"杨桃",   color:"#F0D840", seed_cost:320, grow_secs:345_600, base_yield:60, sell_per_unit:40, seasons:3 },
    CropDef { id:"magic_melon",  name_cn:"魔法甜瓜",color:"#A040E8",seed_cost:400, grow_secs:432_000, base_yield:70, sell_per_unit:50, seasons:3 },
    CropDef { id:"golden_tomato",name_cn:"黄金番茄",color:"#FFD700",seed_cost:500, grow_secs:432_000, base_yield:75, sell_per_unit:55, seasons:3 },
    CropDef { id:"rainbow_pepper",name_cn:"彩虹辣椒",color:"#FF60A0",seed_cost:600,grow_secs:518_400, base_yield:80, sell_per_unit:65, seasons:4 },
    CropDef { id:"crystal_berry",name_cn:"水晶莓", color:"#80D0FF", seed_cost:800, grow_secs:604_800, base_yield:90, sell_per_unit:80, seasons:4 },
    CropDef { id:"moon_lotus",   name_cn:"月亮莲", color:"#C0A0FF", seed_cost:1000,grow_secs:604_800, base_yield:100,sell_per_unit:100,seasons:5 },
    CropDef { id:"star_melon",   name_cn:"星光甜瓜",color:"#60E8FF",seed_cost:1200,grow_secs:691_200, base_yield:110,sell_per_unit:120,seasons:5 },
    CropDef { id:"golden_lotus",  name_cn:"地涌金莲",color:"#FFB820",seed_cost:1500,grow_secs:720_000, base_yield:130,sell_per_unit:160,seasons:6 },
    CropDef { id:"phoenix_flower",name_cn:"凤凰花",color:"#FF4820", seed_cost:2000,grow_secs:777_600, base_yield:150,sell_per_unit:200,seasons:6 },
    // ── Flowers (seasonal blooms, multi-harvest) ─────────────────────
    CropDef { id:"sunflower",     name_cn:"向日葵", color:"#FFCC00", seed_cost:30,  grow_secs:21_600,  base_yield:12, sell_per_unit:6,  seasons:1 },
    CropDef { id:"rose",          name_cn:"玫瑰花", color:"#E82060", seed_cost:45,  grow_secs:36_000,  base_yield:16, sell_per_unit:9,  seasons:4 },
    CropDef { id:"lavender",      name_cn:"薰衣草", color:"#9060D0", seed_cost:50,  grow_secs:43_200,  base_yield:18, sell_per_unit:10, seasons:3 },
    CropDef { id:"lily",          name_cn:"百合花", color:"#FFF0C0", seed_cost:60,  grow_secs:57_600,  base_yield:20, sell_per_unit:12, seasons:2 },
    CropDef { id:"peony",         name_cn:"牡丹花", color:"#E84080", seed_cost:80,  grow_secs:72_000,  base_yield:24, sell_per_unit:14, seasons:3 },
    CropDef { id:"lotus",         name_cn:"荷花",   color:"#F080B0", seed_cost:90,  grow_secs:86_400,  base_yield:26, sell_per_unit:16, seasons:3 },
    CropDef { id:"orchid",        name_cn:"兰花",   color:"#C060E0", seed_cost:120, grow_secs:108_000, base_yield:30, sell_per_unit:20, seasons:4 },
    CropDef { id:"chrysanthemum", name_cn:"菊花",   color:"#FFD040", seed_cost:100, grow_secs:90_000,  base_yield:28, sell_per_unit:17, seasons:4 },
    CropDef { id:"tulip",         name_cn:"郁金香", color:"#E84060", seed_cost:70,  grow_secs:64_800,  base_yield:22, sell_per_unit:13, seasons:2 },
    CropDef { id:"morning_glory", name_cn:"牵牛花", color:"#6080E8", seed_cost:25,  grow_secs:14_400,  base_yield:10, sell_per_unit:5,  seasons:3 },
    CropDef { id:"marigold",      name_cn:"万寿菊", color:"#F08020", seed_cost:8,   grow_secs:3_600,   base_yield:5,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"dandelion",     name_cn:"蒲公英", color:"#F8D820", seed_cost:5,   grow_secs:1_800,   base_yield:4,  sell_per_unit:1,  seasons:1 },
    CropDef { id:"daisy",         name_cn:"雏菊",   color:"#FFF8D0", seed_cost:6,   grow_secs:2_400,   base_yield:4,  sell_per_unit:1,  seasons:1 },
    CropDef { id:"pansy",         name_cn:"三色堇", color:"#9040D8", seed_cost:10,  grow_secs:4_800,   base_yield:6,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"violet",        name_cn:"紫罗兰", color:"#7830C8", seed_cost:12,  grow_secs:5_400,   base_yield:6,  sell_per_unit:2,  seasons:1 },
    // ── Trees (high seasons, long grow, premium) ─────────────────────
    CropDef { id:"cherry_blossom",name_cn:"樱花树", color:"#FFB8D0", seed_cost:200, grow_secs:259_200, base_yield:60, sell_per_unit:35, seasons:8 },
    CropDef { id:"osmanthus",     name_cn:"桂花树", color:"#FFC060", seed_cost:250, grow_secs:302_400, base_yield:65, sell_per_unit:40, seasons:10},
    CropDef { id:"pine_tree",     name_cn:"松树",   color:"#2A6020", seed_cost:300, grow_secs:345_600, base_yield:70, sell_per_unit:45, seasons:12},
    CropDef { id:"peach_tree",    name_cn:"桃花树", color:"#FFB0C0", seed_cost:220, grow_secs:273_600, base_yield:62, sell_per_unit:38, seasons:8 },
    CropDef { id:"plum_tree",     name_cn:"梅花树", color:"#E060A0", seed_cost:260, grow_secs:316_800, base_yield:68, sell_per_unit:42, seasons:10},
    CropDef { id:"bamboo",        name_cn:"翠竹",   color:"#40A030", seed_cost:150, grow_secs:172_800, base_yield:50, sell_per_unit:30, seasons:6 },
    // ── Aquatic crops (pool / pond tiles only) ──────────────────────
    CropDef { id:"water_spinach",  name_cn:"空心菜", color:"#40C878", seed_cost:15,   grow_secs:3_600,   base_yield:7,  sell_per_unit:2,  seasons:1 },
    CropDef { id:"lotus_root",     name_cn:"莲藕",   color:"#F0E8D8", seed_cost:50,   grow_secs:21_600,  base_yield:18, sell_per_unit:8,  seasons:1 },
    CropDef { id:"water_lily",     name_cn:"睡莲",   color:"#FFB0D0", seed_cost:80,   grow_secs:43_200,  base_yield:25, sell_per_unit:14, seasons:2 },
    CropDef { id:"taro",           name_cn:"芋头",   color:"#C090C8", seed_cost:110,  grow_secs:86_400,  base_yield:35, sell_per_unit:22, seasons:1 },
    CropDef { id:"water_chestnut", name_cn:"荸荠",   color:"#6A3820", seed_cost:160,  grow_secs:172_800, base_yield:50, sell_per_unit:32, seasons:2 },
];

pub fn find_crop(id: &str) -> Option<&'static CropDef> {
    CROPS.iter().find(|c| c.id == id)
}

pub fn is_aquatic_crop(id: &str) -> bool {
    matches!(id, "water_spinach" | "lotus_root" | "water_lily" | "taro" | "water_chestnut")
}

pub const POOL_SIZE: usize = 8;

// ── Tile skin definitions ─────────────────────────────────────────────────────

pub struct TileSkinDef {
    pub id: &'static str,
    pub name_cn: &'static str,
    pub crop_cost: &'static [(&'static str, u64)],
    pub soil_dark: &'static str,   // dark soil color
    pub soil_light: &'static str,  // light soil color
    pub yield_bonus: f64,          // 1.0 = none
    pub speed_bonus: f64,          // fraction of grow_secs to shave off, 0.0 = none
    pub desc: &'static str,
}

pub const TILE_SKINS: &[TileSkinDef] = &[
    TileSkinDef { id:"default", name_cn:"黄土地", crop_cost:&[], soil_dark:"#9C3C18", soil_light:"#C05430", yield_bonus:1.0, speed_bonus:0.0,  desc:"默认土地" },
    TileSkinDef { id:"red",     name_cn:"红土地", crop_cost:&[("carrot",80),("tomato",40)], soil_dark:"#7A2010", soil_light:"#A42C1C", yield_bonus:1.1, speed_bonus:0.0,  desc:"产量 +10%" },
    TileSkinDef { id:"black",   name_cn:"黑土地", crop_cost:&[("eggplant",100),("grape",30)], soil_dark:"#2A1E12", soil_light:"#3E2C1A", yield_bonus:1.2, speed_bonus:0.1,  desc:"产量 +20%  生长 -10%" },
    TileSkinDef { id:"gold",     name_cn:"金土地",  crop_cost:&[("corn",200),("sunflower",60),("starfruit",5)],          soil_dark:"#B88020", soil_light:"#E0AA30", yield_bonus:1.3,  speed_bonus:0.15, desc:"产量 +30%  生长 -15%" },
    TileSkinDef { id:"purple",   name_cn:"紫晶土地",crop_cost:&[("cherry",40),("mushroom",20),("blueberry",30)],         soil_dark:"#5A1888", soil_light:"#8830C0", yield_bonus:1.45, speed_bonus:0.20, desc:"产量 +45%  生长 -20%" },
    TileSkinDef { id:"jade",     name_cn:"翡翠土地",crop_cost:&[("dragon_fruit",20),("orange",40),("watermelon",20)],    soil_dark:"#0A5030", soil_light:"#20A860", yield_bonus:1.55, speed_bonus:0.25, desc:"产量 +55%  生长 -25%" },
    TileSkinDef { id:"crystal",  name_cn:"水晶土地",crop_cost:&[("magic_melon",10),("crystal_berry",8),("starfruit",6)], soil_dark:"#104898", soil_light:"#3898D8", yield_bonus:1.70, speed_bonus:0.30, desc:"产量 +70%  生长 -30%" },
    TileSkinDef { id:"celestial",name_cn:"仙灵土地",crop_cost:&[("golden_lotus",5),("phoenix_flower",3),("moon_lotus",4)],soil_dark:"#7818C8", soil_light:"#C040F8", yield_bonus:2.00, speed_bonus:0.35, desc:"产量翻倍！生长 -35%" },
];

pub fn find_tile_skin(id: &str) -> &'static TileSkinDef {
    TILE_SKINS.iter().find(|s| s.id == id).unwrap_or(&TILE_SKINS[0])
}

// ── Decoration definitions ────────────────────────────────────────────────────

pub struct DecorationDef {
    pub id: &'static str,
    pub name_cn: &'static str,
    pub crop_cost: &'static [(&'static str, u64)],
    pub desc: &'static str,
}

pub const DECORATIONS: &[DecorationDef] = &[
    DecorationDef { id:"flower",     name_cn:"花坛",   crop_cost:&[("spinach",20),("lettuce",20)],     desc:"五彩花圃" },
    DecorationDef { id:"mushroom",   name_cn:"大蘑菇", crop_cost:&[("potato",30),("lettuce",10)],      desc:"神奇的大蘑菇" },
    DecorationDef { id:"scarecrow",  name_cn:"稻草人", crop_cost:&[("wheat",30),("corn",15)],          desc:"驱鸟守护农场" },
    DecorationDef { id:"lantern",    name_cn:"红灯笼", crop_cost:&[("radish",40),("carrot",20)],       desc:"喜庆的红灯笼" },
    DecorationDef { id:"beehive",    name_cn:"蜂巢",   crop_cost:&[("sunflower",20),("blueberry",10)], desc:"勤劳的蜜蜂" },
    DecorationDef { id:"pond",       name_cn:"小池塘", crop_cost:&[("watermelon",10),("blueberry",20)],desc:"清澈的小鱼塘" },
    DecorationDef { id:"windmill",   name_cn:"风车",   crop_cost:&[("wheat",60),("potato",30)],        desc:"旋转的风车" },
    DecorationDef { id:"fountain",   name_cn:"小喷泉", crop_cost:&[("melon",20),("peach",10)],         desc:"叮咚的小喷泉" },
    DecorationDef { id:"rainbow",    name_cn:"彩虹",   crop_cost:&[("strawberry",40),("grape",15)],    desc:"梦幻彩虹拱门" },
    DecorationDef { id:"barn",           name_cn:"谷仓",   crop_cost:&[("pumpkin",30),("watermelon",20),("corn",50)],       desc:"丰收的大谷仓" },
    // ── Tier 2: mid-game decorations ────────────────────────────────────────
    DecorationDef { id:"well",           name_cn:"古井",   crop_cost:&[("wheat",40),("potato",20)],                         desc:"古朴的石砌水井" },
    DecorationDef { id:"fence",          name_cn:"木栅栏", crop_cost:&[("corn",30),("wheat",30)],                           desc:"爱心造型木栅栏" },
    DecorationDef { id:"doghouse",       name_cn:"小狗窝", crop_cost:&[("carrot",50),("corn",20)],                          desc:"可爱的狗狗小屋" },
    DecorationDef { id:"cottage",        name_cn:"小木屋", crop_cost:&[("pumpkin",25),("cotton",15)],                       desc:"温馨的田园小屋" },
    DecorationDef { id:"gazebo",         name_cn:"凉亭",   crop_cost:&[("cherry",20),("peach",10)],                         desc:"江南水乡风格凉亭" },
    // ── Tier 3: high-level decorations ──────────────────────────────────────
    DecorationDef { id:"waterwheel",     name_cn:"水车",   crop_cost:&[("watermelon",15),("melon",20)],                     desc:"古风转动水车" },
    DecorationDef { id:"hot_air_balloon",name_cn:"热气球", crop_cost:&[("strawberry",30),("grape",10)],                     desc:"彩色热气球高空漫游" },
    DecorationDef { id:"stone_arch",     name_cn:"石拱门", crop_cost:&[("apple",20),("pomegranate",10)],                    desc:"爬满藤蔓的石拱门" },
    DecorationDef { id:"maple_tree",     name_cn:"枫叶树", crop_cost:&[("orange",25),("lychee",10)],                        desc:"秋日金红枫叶树" },
    DecorationDef { id:"greenhouse",     name_cn:"玻璃温室",crop_cost:&[("dragon_fruit",10),("crystal_berry",5)],           desc:"高科技玻璃温室" },
];

pub fn find_decoration(id: &str) -> Option<&'static DecorationDef> {
    DECORATIONS.iter().find(|d| d.id == id)
}

// ── Land expansion ────────────────────────────────────────────────────────────

/// (tile_count, cost_to_unlock)
pub const LAND_LEVELS: &[(usize, u64)] = &[
    (30,  0),
    (36,  200),
    (42,  600),
    (48,  1500),
    (60,  5000),
];

pub fn next_land_level(current: usize) -> Option<(usize, u64)> {
    LAND_LEVELS.iter().find(|(n, _)| *n > current).copied()
}

// ── Level / XP system ─────────────────────────────────────────────────────────

/// XP thresholds to reach level N+2 (index 0 = XP needed to reach Lv2, etc.)
pub const LEVEL_XP_THRESHOLDS: &[u64] = &[
    50, 150, 300, 500, 750, 1_100, 1_600, 2_200, 3_000, 4_000,
    5_500, 7_500, 10_000, 13_500, 18_000, 24_000, 32_000, 42_000, 56_000, 75_000,
    100_000, 130_000, 165_000, 210_000, 265_000, 330_000, 410_000, 510_000, 640_000, 800_000,
    1_000_000, 1_250_000, 1_600_000, 2_000_000, 2_500_000,
];

pub fn calc_level(xp: u64) -> u32 {
    1 + LEVEL_XP_THRESHOLDS.iter().take_while(|&&t| xp >= t).count() as u32
}

pub fn xp_to_next_level(xp: u64) -> Option<u64> {
    let lv = calc_level(xp) as usize;
    LEVEL_XP_THRESHOLDS.get(lv - 1).map(|&t| t.saturating_sub(xp))
}

pub fn xp_at_level(lv: u32) -> u64 {
    if lv <= 1 { 0 } else { LEVEL_XP_THRESHOLDS.get((lv - 2) as usize).copied().unwrap_or(u64::MAX) }
}

/// Level requirement for each crop id (returns 1 if unlocked from the start)
pub fn crop_level_req(crop_id: &str) -> u32 {
    match crop_id {
        "spinach"|"lettuce"|"wheat"|"radish"|"onion"|"morning_glory"|"marigold"|"dandelion"|"daisy"|"pansy"|"violet" => 1,
        "garlic"|"carrot"|"green_bean"|"leek"|"potato" => 3,
        "rose"|"lavender" => 4,
        "sweet_potato"|"cucumber"|"corn"|"pepper"|"asparagus"|"tomato"
        |"broccoli"|"cauliflower"|"cabbage"|"eggplant" => 5,
        "lily"|"tulip" => 6,
        "bamboo" => 7,
        "cotton"|"sunflower"|"pumpkin"|"melon"|"blueberry"|"cantaloupe"|"strawberry" => 8,
        "peony"|"chrysanthemum"|"lotus" => 10,
        "cherry"|"peach"|"watermelon"|"peanut"|"mushroom"|"lychee"|"orange" => 12,
        "pear"|"apple"|"pomegranate"|"grape"|"longan"|"mango"|"pineapple"|"banana"
        |"cherry_blossom"|"peach_tree" => 15,
        "coconut"|"dragon_fruit"|"starfruit"|"orchid"|"osmanthus"|"plum_tree" => 18,
        "magic_melon"|"golden_tomato"|"rainbow_pepper"|"crystal_berry"|"pine_tree" => 25,
        "moon_lotus"|"star_melon"|"golden_lotus"|"phoenix_flower" => 35,
        // Aquatic crops
        "water_spinach" => 3,
        "lotus_root" => 5,
        "water_lily" => 8,
        "taro" => 11,
        "water_chestnut" => 14,
        _ => 1,
    }
}

fn xp_for_harvest(crop: &CropDef, units: u64) -> u64 {
    let time_xp = ((crop.grow_secs as f64 / 360.0).ceil() as u64).max(5);
    time_xp + units / 5
}

// ── Game constants ────────────────────────────────────────────────────────────

pub const FERTILIZER_COIN_COST: u64 = 50;
const DRY_AFTER_SECS: u64 = 14_400;
const HEALTH_DECAY_AFTER_SECS: u64 = 28_800;
const HEALTH_DECAY_PER_HOUR: u8 = 10;
const FERTILIZER_BONUS_SECS: u64 = 1_800;
const XP_PLANT: u64 = 2;
const XP_WATER: u64 = 2;
const XP_REMOVE_PEST: u64 = 2;
const XP_REMOVE_WEED: u64 = 2;
const XP_CLEAR_WITHERED: u64 = 3;
const GOLDEN_HARVEST_PERCENT: u64 = 8;
const PEST_SPAWN_INTERVAL_SECS: u64 = 7_200;  // check every 2 hours
const WEED_SPAWN_INTERVAL_SECS: u64 = 10_800; // check every 3 hours
const PEST_CHANCE_PERCENT: u64 = 28;
const WEED_CHANCE_PERCENT: u64 = 22;

/// Simple deterministic pseudo-random returning 0..99
fn pseudo_rand(seed: u64) -> u64 {
    let mut x = seed.wrapping_add(1);
    x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x % 100
}

// ── Tile ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FarmTile {
    pub crop_id: Option<String>,
    pub planted_at: u64,
    pub last_watered: u64,
    pub health: u8,
    pub fertilized_stages: Vec<u8>,
    pub times_harvested: u8,
    pub fertilizer_bonus_secs: u64,
    #[serde(default = "default_skin")]
    pub skin_id: String,
    /// Tile has a withered dead plant — must be shovelled before replanting
    #[serde(default)]
    pub is_withered: bool,
    /// Pest is present — remove with shovel for XP+coins
    #[serde(default)]
    pub has_pest: bool,
    /// Weed is present — remove with shovel for XP+coins
    #[serde(default)]
    pub has_weed: bool,
    /// Timestamp of last pest/weed spawn check
    #[serde(default)]
    pub last_event_check: u64,
}

fn default_skin() -> String { "default".to_string() }

impl FarmTile {
    pub fn is_empty(&self) -> bool { self.crop_id.is_none() && !self.is_withered }

    fn skin(&self) -> &'static TileSkinDef { find_tile_skin(&self.skin_id) }

    fn adjusted_grow_secs(&self, crop: &CropDef) -> u64 {
        let reduction = (crop.grow_secs as f64 * self.skin().speed_bonus) as u64;
        crop.grow_secs.saturating_sub(reduction).max(60)
    }

    fn effective_elapsed(&self, crop: &CropDef) -> u64 {
        let elapsed = now_secs().saturating_sub(self.planted_at);
        elapsed.saturating_add(self.fertilizer_bonus_secs)
            .min(self.adjusted_grow_secs(crop))
    }

    pub fn progress(&self) -> f64 {
        let crop = match self.crop_id.as_deref().and_then(find_crop) { Some(c) => c, None => return 0.0 };
        let total = self.adjusted_grow_secs(crop);
        self.effective_elapsed(crop) as f64 / total as f64
    }

    pub fn stage(&self) -> u8 {
        let p = self.progress();
        if p >= 1.0 { 4 } else if p >= 0.75 { 3 } else if p >= 0.50 { 2 } else if p >= 0.25 { 1 } else { 0 }
    }

    pub fn is_ripe(&self) -> bool { self.crop_id.is_some() && self.progress() >= 1.0 }

    pub fn secs_remaining(&self) -> i64 {
        let crop = match self.crop_id.as_deref().and_then(find_crop) { Some(c) => c, None => return 0 };
        let total = self.adjusted_grow_secs(crop) as i64;
        total - self.effective_elapsed(crop) as i64
    }

    pub fn is_dry(&self) -> bool {
        if self.crop_id.is_none() || self.is_ripe() { return false; }
        now_secs().saturating_sub(self.last_watered) > DRY_AFTER_SECS
    }

    pub fn tick_health(&mut self) {
        if self.crop_id.is_none() || self.is_ripe() { return; }
        let since = now_secs().saturating_sub(self.last_watered);
        if since > HEALTH_DECAY_AFTER_SECS {
            let hours = ((since - HEALTH_DECAY_AFTER_SECS) / 3600) as u8;
            self.health = self.health.saturating_sub(hours.saturating_mul(HEALTH_DECAY_PER_HOUR));
        }
    }
}

// ── Farm data ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FarmData {
    pub tiles: Vec<FarmTile>,
    pub tile_count: usize,
    pub coins_spent_farm: u64,
    pub coins_earned_farm: u64,
    pub total_harvests: u64,
    pub owned_decorations: Vec<String>,
    #[serde(default)]
    pub inventory: HashMap<String, u64>,
    /// Coins earned by selling harvested crops → spent on land/decorations
    #[serde(default)]
    pub harvest_coins: u64,
    /// Cumulative XP earned from harvesting crops
    #[serde(default)]
    pub player_xp: u64,
    /// Saved tokens spent on fertilizer
    #[serde(default)]
    pub saved_tokens_spent_farm: u64,
    #[serde(default)]
    pub total_pests_removed: u64,
    #[serde(default)]
    pub total_weeds_removed: u64,
    #[serde(default = "default_pool_tiles")]
    pub pool_tiles: Vec<FarmTile>,
}

fn default_pool_tiles() -> Vec<FarmTile> {
    (0..POOL_SIZE).map(|_| FarmTile::default()).collect()
}

impl Default for FarmData {
    fn default() -> Self {
        FarmData {
            tiles: (0..30).map(|_| FarmTile::default()).collect(),
            tile_count: 16,
            coins_spent_farm: 0,
            coins_earned_farm: 0,
            total_harvests: 0,
            owned_decorations: vec![],
            inventory: HashMap::new(),
            harvest_coins: 0,
            player_xp: 0,
            saved_tokens_spent_farm: 0,
            total_pests_removed: 0,
            total_weeds_removed: 0,
            pool_tiles: default_pool_tiles(),
        }
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

pub struct FarmStore {
    pub data: FarmData,
    file_path: PathBuf,
}

impl FarmStore {
    pub fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let file_path = home.join(".terse").join("farm.json");
        let mut data: FarmData = if file_path.exists() {
            fs::read_to_string(&file_path).ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            FarmData::default()
        };
        // Ensure tiles vec is large enough for tile_count
        while data.tiles.len() < data.tile_count {
            data.tiles.push(FarmTile::default());
        }
        // Ensure pool_tiles has POOL_SIZE entries
        while data.pool_tiles.len() < POOL_SIZE {
            data.pool_tiles.push(FarmTile::default());
        }
        FarmStore { data, file_path }
    }

    fn save(&self) {
        let dir = self.file_path.parent().unwrap();
        let _ = fs::create_dir_all(dir);
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    fn tick_events(&mut self, idx: usize) {
        let now = now_secs();
        let t = &mut self.data.tiles[idx];
        if t.crop_id.is_none() || t.is_ripe() || t.is_withered { return; }
        if now.saturating_sub(t.last_event_check) < PEST_SPAWN_INTERVAL_SECS { return; }
        t.last_event_check = now;
        let base_seed = (idx as u64)
            .wrapping_mul(31337)
            .wrapping_add(t.planted_at)
            .wrapping_add(now / PEST_SPAWN_INTERVAL_SECS);
        if !t.has_pest && pseudo_rand(base_seed) < PEST_CHANCE_PERCENT {
            t.has_pest = true;
        }
        if !t.has_weed && pseudo_rand(base_seed.wrapping_add(777_777)) < WEED_CHANCE_PERCENT {
            t.has_weed = true;
        }
    }

    fn tick_pool_events(&mut self, idx: usize) {
        let now = now_secs();
        let t = &mut self.data.pool_tiles[idx];
        if t.crop_id.is_none() || t.is_ripe() || t.is_withered { return; }
        if now.saturating_sub(t.last_event_check) < PEST_SPAWN_INTERVAL_SECS { return; }
        t.last_event_check = now;
        let base_seed = (idx as u64).wrapping_add(99999)
            .wrapping_mul(31337)
            .wrapping_add(t.planted_at)
            .wrapping_add(now / PEST_SPAWN_INTERVAL_SECS);
        // Aquatic crops have lower pest chance
        if !t.has_pest && pseudo_rand(base_seed) < PEST_CHANCE_PERCENT / 2 {
            t.has_pest = true;
        }
        // No weeds in pool tiles
    }

    fn tile_json(i: usize, t: &FarmTile, is_pool: bool) -> serde_json::Value {
        let crop = t.crop_id.as_deref().and_then(find_crop);
        let skin = t.skin();
        let stage = t.stage();
        serde_json::json!({
            "index": i,
            "cropId": t.crop_id,
            "cropNameCn": crop.map(|c| c.name_cn),
            "cropColor": crop.map(|c| c.color),
            "health": t.health,
            "stage": stage,
            "progress": t.progress(),
            "isRipe": t.is_ripe(),
            "isDry": t.is_dry(),
            "secsRemaining": t.secs_remaining(),
            "timesHarvested": t.times_harvested,
            "seasons": crop.map(|c| c.seasons).unwrap_or(0),
            "canFertilize": crop.is_some() && !t.fertilized_stages.contains(&stage) && !t.is_ripe(),
            "isWithered": t.is_withered,
            "hasPest": t.has_pest,
            "hasWeed": t.has_weed,
            "skinId": t.skin_id,
            "skinDark": skin.soil_dark,
            "skinLight": skin.soil_light,
            "isPool": is_pool,
        })
    }

    pub fn get_state(&mut self, coin_balance: u64, _saved_token_balance: u64) -> serde_json::Value {
        for i in 0..self.data.tiles.len() {
            self.data.tiles[i].tick_health();
            if i < self.data.tile_count { self.tick_events(i); }
        }
        for i in 0..POOL_SIZE {
            self.data.pool_tiles[i].tick_health();
            self.tick_pool_events(i);
        }

        // Clone tiles data to avoid borrow conflict with self
        let grass_tiles_data: Vec<FarmTile> = self.data.tiles[..self.data.tile_count].to_vec();
        let tiles: Vec<_> = grass_tiles_data.iter().enumerate()
            .map(|(i, t)| Self::tile_json(i, t, false)).collect();
        let pool_tiles_data: Vec<FarmTile> = self.data.pool_tiles.clone();
        let pool_tiles_json: Vec<_> = pool_tiles_data.iter().enumerate()
            .map(|(i, t)| Self::tile_json(i, t, true)).collect();

        let player_level = calc_level(self.data.player_xp);
        let xp_next = xp_to_next_level(self.data.player_xp);
        let xp_this_level = xp_at_level(player_level);
        let xp_range = xp_at_level(player_level + 1).saturating_sub(xp_this_level);
        let xp_progress = if xp_range > 0 {
            (self.data.player_xp.saturating_sub(xp_this_level)) as f64 / xp_range as f64
        } else { 1.0 };

        let crops: Vec<_> = CROPS.iter().map(|c| serde_json::json!({
            "id": c.id, "nameCn": c.name_cn, "color": c.color,
            "seedCost": c.seed_cost, "growSecs": c.grow_secs,
            "baseYield": c.base_yield, "sellPerUnit": c.sell_per_unit, "seasons": c.seasons,
            "levelReq": crop_level_req(c.id),
            "isAquatic": is_aquatic_crop(c.id),
        })).collect();

        let tile_skins: Vec<_> = TILE_SKINS.iter().map(|s| {
            let crop_cost: Vec<_> = s.crop_cost.iter().map(|(crop_id, amount)| {
                serde_json::json!({"cropId": crop_id, "amount": amount})
            }).collect();
            serde_json::json!({
                "id": s.id, "nameCn": s.name_cn,
                "cropCost": crop_cost,
                "soilDark": s.soil_dark, "soilLight": s.soil_light,
                "yieldBonus": s.yield_bonus, "speedBonus": s.speed_bonus, "desc": s.desc,
            })
        }).collect();

        let decorations: Vec<_> = DECORATIONS.iter().map(|d| {
            let crop_cost: Vec<_> = d.crop_cost.iter().map(|(crop_id, amount)| {
                serde_json::json!({"cropId": crop_id, "amount": amount})
            }).collect();
            serde_json::json!({
                "id": d.id, "nameCn": d.name_cn,
                "cropCost": crop_cost,
                "desc": d.desc,
                "owned": self.data.owned_decorations.contains(&d.id.to_string()),
            })
        }).collect();

        let next_land = next_land_level(self.data.tile_count)
            .map(|(n, c)| serde_json::json!({"tiles": n, "harvestCoinCost": c}));

        serde_json::json!({
            "tiles": tiles,
            "tileCount": self.data.tile_count,
            "crops": crops,
            "tileSkins": tile_skins,
            "decorations": decorations,
            "ownedDecorations": self.data.owned_decorations,
            "coinBalance": coin_balance,
            "harvestCoins": self.data.harvest_coins,
            "playerXp": self.data.player_xp,
            "playerLevel": player_level,
            "playerXpToNext": xp_next,
            "playerXpProgress": xp_progress,
            "totalHarvests": self.data.total_harvests,
            "fertilizerCost": FERTILIZER_COIN_COST,
            "fertilizerCostType": "coins",
            "nextLand": next_land,
            "inventory": &self.data.inventory,
            "poolTiles": pool_tiles_json,
        })
    }

    pub fn plant(&mut self, idx: usize, crop_id: &str, coin_balance: u64) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("tile not unlocked".into()); }
        if self.data.tiles[idx].is_withered { return Err("先用铲子清除枯萎作物".into()); }
        if !self.data.tiles[idx].is_empty() { return Err("tile occupied".into()); }
        let crop = find_crop(crop_id).ok_or("unknown crop")?;
        if coin_balance < crop.seed_cost { return Err(format!("need {} coins", crop.seed_cost)); }
        let player_level = calc_level(self.data.player_xp);
        let req = crop_level_req(crop_id);
        if player_level < req { return Err(format!("需要 {} 级才能种植 {}", req, crop.name_cn)); }
        let now = now_secs();
        let skin = self.data.tiles[idx].skin_id.clone();
        self.data.tiles[idx] = FarmTile {
            crop_id: Some(crop_id.to_string()),
            planted_at: now, last_watered: now, health: 100,
            fertilized_stages: vec![], times_harvested: 0, fertilizer_bonus_secs: 0,
            skin_id: skin, is_withered: false, has_pest: false, has_weed: false,
            last_event_check: now,
        };
        self.data.coins_spent_farm += crop.seed_cost;
        self.data.player_xp += XP_PLANT;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_PLANT }))
    }

    // ── Pool tile operations ──────────────────────────────────────────────

    pub fn pool_plant(&mut self, idx: usize, crop_id: &str, coin_balance: u64) -> Result<serde_json::Value, String> {
        if idx >= POOL_SIZE { return Err("invalid pool tile".into()); }
        if !is_aquatic_crop(crop_id) { return Err("只能在水中种植水生作物".into()); }
        if self.data.pool_tiles[idx].is_withered { return Err("先清除枯萎植物".into()); }
        if !self.data.pool_tiles[idx].is_empty() { return Err("tile occupied".into()); }
        let crop = find_crop(crop_id).ok_or("unknown crop")?;
        if coin_balance < crop.seed_cost { return Err(format!("need {} coins", crop.seed_cost)); }
        let player_level = calc_level(self.data.player_xp);
        let req = crop_level_req(crop_id);
        if player_level < req { return Err(format!("需要 {} 级才能种植 {}", req, crop.name_cn)); }
        let now = now_secs();
        self.data.pool_tiles[idx] = FarmTile {
            crop_id: Some(crop_id.to_string()),
            planted_at: now, last_watered: now, health: 100,
            fertilized_stages: vec![], times_harvested: 0, fertilizer_bonus_secs: 0,
            skin_id: "default".to_string(), is_withered: false, has_pest: false, has_weed: false,
            last_event_check: now,
        };
        self.data.coins_spent_farm += crop.seed_cost;
        self.data.player_xp += XP_PLANT;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_PLANT }))
    }

    pub fn pool_water(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= POOL_SIZE { return Err("invalid pool tile".into()); }
        let t = &mut self.data.pool_tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if t.is_ripe() { return Err("已成熟，先收割！".into()); }
        t.last_watered = now_secs();
        self.data.player_xp += XP_WATER;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_WATER }))
    }

    pub fn pool_harvest(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= POOL_SIZE { return Err("invalid pool tile".into()); }
        let t = &self.data.pool_tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if !t.is_ripe() { return Err("还没成熟".into()); }
        let crop_id = t.crop_id.clone().unwrap();
        let crop = find_crop(&crop_id).ok_or("unknown crop")?;
        let skin = t.skin();
        let is_golden = pseudo_rand(t.planted_at.wrapping_add(now_secs())) < GOLDEN_HARVEST_PERCENT;
        let base_units = crop.base_yield as f64 * skin.yield_bonus;
        let units = if is_golden { (base_units * 2.0) as u64 } else { base_units as u64 };
        let xp = xp_for_harvest(crop, units);
        let can_reharvest = t.times_harvested + 1 < crop.seasons as u8;
        let inv_entry = self.data.inventory.entry(crop_id.clone()).or_insert(0);
        *inv_entry += units;
        let harvest_coins = units * crop.sell_per_unit / 3;
        self.data.harvest_coins += harvest_coins;
        self.data.player_xp += xp;
        self.data.total_harvests += 1;
        if can_reharvest {
            let now = now_secs();
            self.data.pool_tiles[idx].planted_at = now;
            self.data.pool_tiles[idx].last_watered = now;
            self.data.pool_tiles[idx].times_harvested += 1;
            self.data.pool_tiles[idx].fertilized_stages.clear();
            self.data.pool_tiles[idx].fertilizer_bonus_secs = 0;
            self.data.pool_tiles[idx].has_pest = false;
        } else {
            self.data.pool_tiles[idx] = FarmTile::default();
        }
        self.save();
        Ok(serde_json::json!({ "units": units, "xpGained": xp, "harvestCoins": harvest_coins, "isGolden": is_golden, "cropNameCn": crop.name_cn }))
    }

    pub fn pool_fertilize(&mut self, idx: usize, coin_balance: u64) -> Result<u64, String> {
        if idx >= POOL_SIZE { return Err("invalid pool tile".into()); }
        let t = &mut self.data.pool_tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if t.is_ripe() { return Err("already ripe".into()); }
        if coin_balance < FERTILIZER_COIN_COST {
            return Err(format!("需要 {} 金币才能施肥", FERTILIZER_COIN_COST));
        }
        let stage = t.stage();
        if t.fertilized_stages.contains(&stage) { return Err("此阶段已施过肥".into()); }
        t.fertilized_stages.push(stage);
        t.fertilizer_bonus_secs += FERTILIZER_BONUS_SECS;
        self.data.coins_spent_farm += FERTILIZER_COIN_COST;
        self.save();
        Ok(FERTILIZER_COIN_COST)
    }

    pub fn pool_clear(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= POOL_SIZE { return Err("invalid pool tile".into()); }
        let t = &mut self.data.pool_tiles[idx];
        let xp = if t.is_withered { XP_CLEAR_WITHERED } else if t.has_pest { XP_REMOVE_PEST } else { 0 };
        self.data.pool_tiles[idx] = FarmTile::default();
        if xp > 0 { self.data.player_xp += xp; }
        self.save();
        Ok(serde_json::json!({ "xpGained": xp }))
    }

    pub fn fertilize(&mut self, idx: usize, coin_balance: u64) -> Result<u64, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if t.is_ripe() { return Err("already ripe".into()); }
        if coin_balance < FERTILIZER_COIN_COST {
            return Err(format!("需要 {} 金币才能施肥", FERTILIZER_COIN_COST));
        }
        let stage = t.stage();
        if t.fertilized_stages.contains(&stage) { return Err("此阶段已施过肥".into()); }
        t.fertilized_stages.push(stage);
        t.fertilizer_bonus_secs += FERTILIZER_BONUS_SECS;
        self.data.coins_spent_farm += FERTILIZER_COIN_COST;
        self.save();
        Ok(FERTILIZER_COIN_COST)
    }

    pub fn harvest(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if !t.is_ripe() { return Err("not ripe yet".into()); }
        let crop_id = t.crop_id.clone().unwrap();
        let crop = find_crop(&crop_id).ok_or("unknown crop")?;
        let skin_bonus = find_tile_skin(&t.skin_id).yield_bonus;
        let planted_at_snap = t.planted_at;
        let base_units = ((crop.base_yield as f64) * (t.health as f64 / 100.0) * skin_bonus).max(1.0) as u64;
        // Golden harvest: 8% chance of double yield
        let golden_seed = self.data.total_harvests.wrapping_add(planted_at_snap).wrapping_mul(7919);
        let is_golden = pseudo_rand(golden_seed) < GOLDEN_HARVEST_PERCENT;
        let units = if is_golden { base_units * 2 } else { base_units };
        t.times_harvested += 1;
        self.data.total_harvests += 1;
        self.data.coins_earned_farm += units;
        let xp_gained = xp_for_harvest(crop, units);
        self.data.player_xp += xp_gained;
        *self.data.inventory.entry(crop_id.clone()).or_insert(0) += units;
        if t.times_harvested >= crop.seasons {
            // Final harvest → withered state; user must shovel to clear
            let skin = t.skin_id.clone();
            *t = FarmTile { skin_id: skin, is_withered: true, ..FarmTile::default() };
        } else {
            let now = now_secs();
            t.planted_at = now; t.last_watered = now;
            t.fertilizer_bonus_secs = 0; t.fertilized_stages.clear();
            t.has_pest = false; t.has_weed = false;
        }
        self.save();
        let mut items = serde_json::Map::new();
        items.insert(crop_id, serde_json::Value::Number(units.into()));
        Ok(serde_json::json!({
            "items": items,
            "units": units,
            "xpGained": xp_gained,
            "isGolden": is_golden,
            "playerLevel": calc_level(self.data.player_xp),
        }))
    }

    pub fn sell_crops(&mut self, crop_id: &str, amount: u64) -> Result<u64, String> {
        let crop = find_crop(crop_id).ok_or("unknown crop")?;
        let held = *self.data.inventory.get(crop_id).unwrap_or(&0);
        if held < amount { return Err(format!("{}:{}:{}", crop_id, amount, held)); }
        *self.data.inventory.entry(crop_id.to_string()).or_insert(0) -= amount;
        let gained = amount * crop.sell_per_unit;
        self.data.harvest_coins += gained;
        self.save();
        Ok(gained)
    }

    pub fn water(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        if t.crop_id.is_none() { return Err("no crop".into()); }
        if t.is_ripe() { return Err("already ripe".into()); }
        t.last_watered = now_secs();
        t.health = t.health.saturating_add(5).min(100);
        self.data.player_xp += XP_WATER;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_WATER }))
    }

    pub fn clear_tile(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        let xp = if t.is_withered { XP_CLEAR_WITHERED } else { 0 };
        // Withered or growing crop → remove pest/weed first if present
        if !t.is_withered && t.has_pest {
            t.has_pest = false;
            self.data.player_xp += XP_REMOVE_PEST;
            self.data.total_pests_removed += 1;
            self.save();
            return Ok(serde_json::json!({ "action": "removePest", "xpGained": XP_REMOVE_PEST, "coinsGained": 1 }));
        }
        if !t.is_withered && t.has_weed {
            t.has_weed = false;
            self.data.player_xp += XP_REMOVE_WEED;
            self.data.total_weeds_removed += 1;
            self.save();
            return Ok(serde_json::json!({ "action": "removeWeed", "xpGained": XP_REMOVE_WEED, "coinsGained": 1 }));
        }
        let skin = self.data.tiles[idx].skin_id.clone();
        self.data.tiles[idx] = FarmTile { skin_id: skin, ..FarmTile::default() };
        if xp > 0 { self.data.player_xp += xp; }
        self.save();
        Ok(serde_json::json!({ "action": "clear", "xpGained": xp }))
    }

    pub fn remove_pest(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        if !t.has_pest { return Err("no pest".into()); }
        t.has_pest = false;
        self.data.player_xp += XP_REMOVE_PEST;
        self.data.total_pests_removed += 1;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_REMOVE_PEST, "coinsGained": 1 }))
    }

    pub fn remove_weed(&mut self, idx: usize) -> Result<serde_json::Value, String> {
        if idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let t = &mut self.data.tiles[idx];
        if !t.has_weed { return Err("no weed".into()); }
        t.has_weed = false;
        self.data.player_xp += XP_REMOVE_WEED;
        self.data.total_weeds_removed += 1;
        self.save();
        Ok(serde_json::json!({ "xpGained": XP_REMOVE_WEED, "coinsGained": 1 }))
    }

    pub fn expand_land(&mut self) -> Result<u64, String> {
        let (new_count, cost) = next_land_level(self.data.tile_count)
            .ok_or("已达最大土地规模")?;
        if self.data.harvest_coins < cost {
            return Err(format!("需要 {} 丰收币，当前 {}", cost, self.data.harvest_coins));
        }
        while self.data.tiles.len() < new_count { self.data.tiles.push(FarmTile::default()); }
        self.data.tile_count = new_count;
        self.data.harvest_coins -= cost;
        self.save();
        Ok(cost)
    }

    pub fn buy_tile_skin(&mut self, tile_idx: usize, skin_id: &str) -> Result<(), String> {
        if tile_idx >= self.data.tile_count { return Err("invalid tile".into()); }
        let skin = find_tile_skin(skin_id);
        if skin.id == "default" { return Err("already default".into()); }
        // Check inventory for each crop cost requirement
        for (crop_id, need) in skin.crop_cost {
            let have = *self.data.inventory.get(*crop_id).unwrap_or(&0);
            if have < *need {
                return Err(format!("{}:{}:{}", crop_id, need, have));
            }
        }
        // Deduct crops from inventory
        for (crop_id, need) in skin.crop_cost {
            *self.data.inventory.entry(crop_id.to_string()).or_insert(0) -= need;
        }
        self.data.tiles[tile_idx].skin_id = skin_id.to_string();
        self.save();
        Ok(())
    }

    pub fn buy_decoration(&mut self, dec_id: &str) -> Result<(), String> {
        let dec = find_decoration(dec_id).ok_or("unknown decoration")?;
        if self.data.owned_decorations.iter().any(|d| d == dec_id) {
            return Err("already owned".into());
        }
        // Check inventory for each crop cost requirement
        for (crop_id, need) in dec.crop_cost {
            let have = *self.data.inventory.get(*crop_id).unwrap_or(&0);
            if have < *need {
                return Err(format!("{}:{}:{}", crop_id, need, have));
            }
        }
        // Deduct crops from inventory
        for (crop_id, need) in dec.crop_cost {
            *self.data.inventory.entry(crop_id.to_string()).or_insert(0) -= need;
        }
        self.data.owned_decorations.push(dec_id.to_string());
        self.save();
        Ok(())
    }

    pub fn add_fishing_coins(&mut self, amount: u64) {
        self.data.coins_earned_farm += amount;
        self.save();
    }
}
