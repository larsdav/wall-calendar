import test from 'node:test';
import assert from 'node:assert/strict';
import { splitItems, newIngredients, cleanMeal, cleanMealSlots } from '../src/logic.js';

test('splitItems splits on commas and lines and trims bullets', () => {
  assert.deepEqual(splitItems('milk, eggs\n- bread\n\n• bananas ;  '), ['milk', 'eggs', 'bread', 'bananas']);
  assert.deepEqual(splitItems(''), []);
  assert.equal(splitItems(Array(60).fill('x').join(',')).length, 40);
});

test('newIngredients skips items already open on the list (case and punctuation insensitive) and duplicates', () => {
  const open = [{ text: 'Ground beef' }, { text: 'Tortillas!' }];
  assert.deepEqual(newIngredients(['ground  beef', 'tortillas', 'Cheese', 'cheese', 'Salsa'], open), ['Cheese', 'Salsa']);
});

test('cleanMeal validates day and slot and parses ingredient text', () => {
  assert.match(cleanMeal({ day: 'x', slot: 'dinner' }).error, /Pick/);
  assert.match(cleanMeal({ day: '2026-10-26', slot: 'brunch' }).error, /Pick/);
  const m = cleanMeal({ day: '2026-10-26', slot: 'dinner', title: ' Tacos ', ingredients: 'beef, shells\ncheese' }).meal;
  assert.deepEqual([m.title, m.ingredients], ['Tacos', ['beef', 'shells', 'cheese']]);
});

test('cleanMealSlots keeps order and falls back to dinner', () => {
  assert.deepEqual(cleanMealSlots(['dinner', 'breakfast']), ['breakfast', 'dinner']);
  assert.deepEqual(cleanMealSlots([]), ['dinner']);
  assert.deepEqual(cleanMealSlots('x'), ['dinner']);
});
