use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Severity {
    Normal = 0,
    Suspicious = 1,
    Alert = 2,
}

impl Severity {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Normal,
            1 => Self::Suspicious,
            _ => Self::Alert,
        }
    }
}

impl Default for Severity {
    fn default() -> Self {
        Self::Normal
    }
}
