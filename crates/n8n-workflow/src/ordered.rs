//! Insertion-ordered map, mirroring the JavaScript object semantics the reference
//! implementation relies on.
//!
//! Two reasons this exists instead of `std::collections::HashMap`:
//!
//! 1. **Order is observable.** The reference iterates `Object.keys(this.nodes)` and
//!    `Object.keys(connections[nodeName])`; `getConnectedNodes(..., 'ALL')` returns a
//!    different array when the connection types are visited in a different order
//!    (see the `all-types` fixture: `['M','D','C','B']`, not `['D','C','B','M']`).
//! 2. **`serde_json::Map` sorts keys** (it is a `BTreeMap` without the `preserve_order`
//!    feature), so deserialising into `Value` first would already have lost the order.
//!    A `Deserialize` impl that walks the map visitor keeps document order.

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OrderedMap<V> {
    entries: Vec<(String, V)>,
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// JS `obj[key] = value`: an existing key keeps its position, only the value is replaced.
    pub fn insert(&mut self, key: String, value: V) -> Option<V> {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => Some(std::mem::replace(slot, value)),
            None => {
                self.entries.push((key, value));
                None
            }
        }
    }

    /// JS `delete obj[key]` / `obj[key]` re-insertion: the key is appended at the end.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let position = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(position).1)
    }

    /// Borrow an existing value or insert `V::default()` — the `map[key] ??= []` idiom.
    pub fn entry_or_insert_default(&mut self, key: &str) -> &mut V
    where
        V: Default,
    {
        if self.get(key).is_none() {
            self.insert(key.to_string(), V::default());
        }
        self.get_mut(key).expect("just inserted")
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(k, _)| k)
    }

    pub fn key_names(&self) -> Vec<String> {
        self.keys().cloned().collect()
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, v)| v)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut V)> {
        self.entries.iter_mut().map(|(k, v)| (&*k, v))
    }

    /// Key order used by the reference: previous keys first, then keys only present here.
    pub fn union_keys(first: &Self, second: &Self) -> Vec<String> {
        let mut keys: Vec<String> = first.key_names();
        for key in second.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
        keys
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

struct OrderedMapVisitor<V> {
    marker: std::marker::PhantomData<V>,
}

impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedMapVisitor<V> {
    type Value = OrderedMap<V>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a map")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
        let mut out = OrderedMap::new();
        while let Some((key, value)) = access.next_entry::<String, V>()? {
            out.insert(key, value);
        }
        Ok(out)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(OrderedMapVisitor {
            marker: std::marker::PhantomData,
        })
    }
}
