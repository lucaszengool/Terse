use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// Cost in coins to unlock a pet or a skin (1 coin = 1 optimization call)
pub const UNLOCK_COST_PET: u64 = 20;
pub const UNLOCK_COST_SKIN: u64 = 20;

// Default skin id every owned pet gets for free.
pub const DEFAULT_SKIN: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetSettings {
    /// Show "+N tokens 🍪" / milestone speech bubbles from the pet.
    #[serde(default = "default_true", rename = "showBubbles")]
    pub show_bubbles: bool,
    /// Play the chomp + crumb animation on each token save.
    #[serde(default = "default_true", rename = "eatAnimation")]
    pub eat_animation: bool,
    /// Play the happy-bounce + sparkles on milestone (every 1000 tokens).
    #[serde(default = "default_true", rename = "milestoneAnimation")]
    pub milestone_animation: bool,
    /// Continuous idle bob/breathing animation.
    #[serde(default = "default_true", rename = "idleAnimation")]
    pub idle_animation: bool,
}

fn default_true() -> bool { true }

impl Default for PetSettings {
    fn default() -> Self {
        Self { show_bubbles: true, eat_animation: true, milestone_animation: true, idle_animation: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PetData {
    /// Pet ids the user owns. The starter pet they pick is the first entry.
    #[serde(default, rename = "ownedPets", alias = "owned_pets")]
    pub owned_pets: Vec<String>,

    /// Currently equipped pet id (None until starter picked).
    #[serde(default, rename = "equippedPet")]
    pub equipped_pet: Option<String>,

    /// True once the user has chosen a starter pet.
    #[serde(default, rename = "starterPicked")]
    pub starter_picked: bool,

    /// Cumulative tokens spent on unlocks (legacy, no longer used for cost checks).
    #[serde(default, rename = "tokensSpent")]
    pub tokens_spent: u64,

    /// Coins earned: 1 per optimization call, regardless of tokens saved.
    #[serde(default, rename = "coinsEarned")]
    pub coins_earned: u64,

    /// Coins spent on pet/skin unlocks.
    #[serde(default, rename = "coinsSpent")]
    pub coins_spent: u64,

    /// pet_id -> list of skin ids owned for that pet (DEFAULT_SKIN auto-added on ownership)
    #[serde(default, rename = "ownedSkins")]
    pub owned_skins: HashMap<String, Vec<String>>,

    /// pet_id -> currently equipped skin id for that pet
    #[serde(default, rename = "equippedSkins")]
    pub equipped_skins: HashMap<String, String>,

    /// User-controlled toggles for pet behavior (bubbles, animations).
    #[serde(default)]
    pub settings: PetSettings,
}

pub struct PetStore {
    data: PetData,
    file_path: PathBuf,
}

impl PetStore {
    pub fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let dir = home.join(".terse");
        let file_path = dir.join("pets.json");

        let data = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            PetData::default()
        };

        PetStore { data, file_path }
    }

    pub fn data(&self) -> &PetData { &self.data }

    /// Pick the starter pet. Idempotent if already picked (returns false).
    pub fn pick_starter(&mut self, pet_id: &str) -> bool {
        if self.data.starter_picked { return false; }
        self.data.owned_pets = vec![pet_id.to_string()];
        self.data.equipped_pet = Some(pet_id.to_string());
        self.data.starter_picked = true;
        self.data.owned_skins.insert(pet_id.to_string(), vec![DEFAULT_SKIN.to_string()]);
        self.data.equipped_skins.insert(pet_id.to_string(), DEFAULT_SKIN.to_string());
        self.save();
        true
    }

    /// Add coins earned from optimizations (1 per call regardless of tokens saved).
    pub fn add_coins(&mut self, n: u64) {
        self.data.coins_earned += n;
        self.save();
    }

    /// Spendable coin balance.
    pub fn coin_balance(&self) -> u64 {
        self.data.coins_earned.saturating_sub(self.data.coins_spent)
    }

    /// Try to unlock a pet for UNLOCK_COST_PET coins. Returns Ok(()) on success.
    pub fn unlock_pet(&mut self, pet_id: &str, _legacy_token_balance: u64) -> Result<(), String> {
        if self.data.owned_pets.iter().any(|p| p == pet_id) {
            return Err("already owned".into());
        }
        let coins = self.coin_balance();
        if coins < UNLOCK_COST_PET {
            return Err(format!("need {} coins, have {}", UNLOCK_COST_PET, coins));
        }
        self.data.owned_pets.push(pet_id.to_string());
        self.data.coins_spent += UNLOCK_COST_PET;
        self.data.owned_skins.entry(pet_id.to_string())
            .or_insert_with(|| vec![DEFAULT_SKIN.to_string()]);
        self.data.equipped_skins.entry(pet_id.to_string())
            .or_insert_with(|| DEFAULT_SKIN.to_string());
        self.save();
        Ok(())
    }

    /// Mark a pet as owned after a successful Stripe purchase (no coin cost).
    pub fn mark_pet_purchased(&mut self, pet_id: &str) {
        if !self.data.owned_pets.iter().any(|p| p == pet_id) {
            self.data.owned_pets.push(pet_id.to_string());
            self.data.owned_skins.entry(pet_id.to_string())
                .or_insert_with(|| vec![DEFAULT_SKIN.to_string()]);
            self.data.equipped_skins.entry(pet_id.to_string())
                .or_insert_with(|| DEFAULT_SKIN.to_string());
            self.save();
        }
    }

    /// Equip an already-owned pet.
    pub fn equip_pet(&mut self, pet_id: &str) -> Result<(), String> {
        if !self.data.owned_pets.iter().any(|p| p == pet_id) {
            return Err("pet not owned".into());
        }
        self.data.equipped_pet = Some(pet_id.to_string());
        self.save();
        Ok(())
    }

    /// Try to unlock a skin for an owned pet.
    pub fn unlock_skin(&mut self, pet_id: &str, skin_id: &str, _legacy_token_balance: u64) -> Result<(), String> {
        if !self.data.owned_pets.iter().any(|p| p == pet_id) {
            return Err("pet not owned".into());
        }
        let coins = self.coin_balance();
        if coins < UNLOCK_COST_SKIN {
            return Err(format!("need {} coins, have {}", UNLOCK_COST_SKIN, coins));
        }
        let owned = self.data.owned_skins.entry(pet_id.to_string())
            .or_insert_with(|| vec![DEFAULT_SKIN.to_string()]);
        if owned.iter().any(|s| s == skin_id) {
            return Err("skin already owned".into());
        }
        owned.push(skin_id.to_string());
        self.data.coins_spent += UNLOCK_COST_SKIN;
        self.save();
        Ok(())
    }

    /// Equip an owned skin on a pet.
    pub fn equip_skin(&mut self, pet_id: &str, skin_id: &str) -> Result<(), String> {
        let owned = match self.data.owned_skins.get(pet_id) {
            Some(v) => v,
            None => return Err("pet not owned".into()),
        };
        if !owned.iter().any(|s| s == skin_id) {
            return Err("skin not owned".into());
        }
        self.data.equipped_skins.insert(pet_id.to_string(), skin_id.to_string());
        self.save();
        Ok(())
    }

    /// Replace settings wholesale.
    pub fn set_settings(&mut self, settings: PetSettings) {
        self.data.settings = settings;
        self.save();
    }

    fn save(&self) {
        let dir = self.file_path.parent().unwrap();
        let _ = fs::create_dir_all(dir);
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file_path, json);
        }
    }
}
