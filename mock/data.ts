/** Seed data and ticket factory for the mock server. Realistic Nigerian resort menu. */

export interface MockStation {
  id: string;
  code: string;
  name: string;
  menu: MockDish[];
  tables: string[];
}

export interface MockDish {
  name: string;
  modifiers: string[];
  notes?: string[];
}

export const STATIONS: MockStation[] = [
  {
    id: '0190a000-0000-7000-8000-000000000001',
    code: 'MAIN_KITCHEN',
    name: 'Main Kitchen',
    tables: ['Table 1', 'Table 4', 'Table 7', 'Table 9', 'Table 12', 'Room 204', 'Room 118'],
    menu: [
      {
        name: 'Jollof rice & grilled chicken',
        modifiers: ['extra spicy', 'no plantain', 'extra chicken'],
      },
      {
        name: 'Pounded yam & egusi',
        modifiers: ['assorted meat', 'no stockfish', 'extra swallow'],
      },
      {
        name: 'Grilled tilapia',
        modifiers: ['well done', 'less pepper'],
        notes: ['allergy: shellfish'],
      },
      { name: 'Fried rice & turkey', modifiers: ['no coleslaw'] },
      { name: 'Club sandwich', modifiers: ['no mayo', 'toasted', 'add fries'] },
      { name: 'Pepper soup (goat)', modifiers: ['extra spicy'] },
      { name: 'Ofada rice & ayamase', modifiers: ['extra ponmo'] },
    ],
  },
  {
    id: '0190a000-0000-7000-8000-000000000002',
    code: 'RESTAURANT_COUNTER',
    name: 'Restaurant Counter',
    tables: ['Counter 1', 'Counter 2', 'Takeaway', 'Table 3', 'Table 5'],
    menu: [
      { name: 'Masala omelette', modifiers: ['no onions', 'add cheese'] },
      { name: 'Pancake stack', modifiers: ['honey', 'no syrup'] },
      { name: 'Cappuccino', modifiers: ['oat milk', 'extra shot', 'decaf'] },
      { name: 'Meat pie', modifiers: ['warmed'] },
      { name: 'Fruit platter', modifiers: [] },
    ],
  },
  {
    id: '0190a000-0000-7000-8000-000000000003',
    code: 'POOL_BAR',
    name: 'Pool Bar',
    tables: ['Cabana 1', 'Cabana 3', 'Lounger 8', 'Lounger 14', 'Pool deck'],
    menu: [
      { name: 'Chapman', modifiers: ['no ice', 'extra cucumber'] },
      { name: 'Virgin mojito', modifiers: ['less sugar'] },
      { name: 'Star lager (60cl)', modifiers: ['very cold'] },
      { name: 'Tropical smoothie', modifiers: ['no banana', 'add protein'] },
      { name: 'Zobo', modifiers: ['no ice'] },
      { name: 'Club soda', modifiers: ['lemon wedge'] },
    ],
  },
  {
    id: '0190a000-0000-7000-8000-000000000004',
    code: 'BUSH_BAR',
    name: 'Bush Bar',
    tables: ['Hut 1', 'Hut 2', 'Fire pit', 'Bar stool 3', 'Bar stool 6'],
    menu: [
      { name: 'Palm wine (calabash)', modifiers: [] },
      { name: 'Guinness stout', modifiers: ['room temperature'] },
      {
        name: 'Suya platter',
        modifiers: ['extra yaji', 'no onions'],
        notes: ['for the whole table'],
      },
      { name: 'Small chops', modifiers: ['no puff-puff'] },
      { name: 'Gin & tonic', modifiers: ['double', 'no ice'] },
    ],
  },
];

export const STAFF = ['Chioma A.', 'Tunde B.', 'Ngozi E.', 'Emeka O.', 'Halima Y.'];

/** Deterministic PRNG so seeded boards are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}
