use edr_core::Category;

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub since_ns: Option<i64>,
    pub until_ns: Option<i64>,
    pub pid: Option<u32>,
    pub category: Option<Category>,
    pub min_severity: Option<u8>,
    pub limit: Option<usize>,
}

impl Query {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn since(mut self, ts: i64) -> Self {
        self.since_ns = Some(ts);
        self
    }

    pub fn until(mut self, ts: i64) -> Self {
        self.until_ns = Some(ts);
        self
    }

    pub fn pid(mut self, pid: u32) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn category(mut self, c: Category) -> Self {
        self.category = Some(c);
        self
    }

    pub fn min_severity(mut self, s: u8) -> Self {
        self.min_severity = Some(s);
        self
    }

    pub fn limit(mut self, n: usize) -> Self {
        self.limit = Some(n);
        self
    }
}
