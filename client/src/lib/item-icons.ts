import {
  Blend, Drill, Lightbulb, Shirt, Book, Tv, Headphones, Camera,
  Laptop, Phone, Watch, Gamepad2, Utensils, CookingPot, Wine,
  Armchair, Fan, Wrench, Hammer, Scissors, Package,
  Gift, Sparkles, ShoppingBag, Box,
} from 'lucide-react';

const ICON_KEYWORDS: [string[], typeof Package][] = [
  [['mixer', 'blender', 'food processor'], Blend],
  [['drill', 'screwdriver', 'tool'], Drill],
  [['light', 'bulb', 'lamp', 'candle'], Lightbulb],
  [['shirt', 'clothes', 'jacket', 'pants', 'dress', 'coat'], Shirt],
  [['book', 'manual', 'guide', 'notebook'], Book],
  [['tv', 'television', 'monitor', 'screen'], Tv],
  [['headphone', 'earphone', 'earbud', 'speaker', 'audio'], Headphones],
  [['camera', 'lens', 'tripod'], Camera],
  [['laptop', 'computer', 'keyboard', 'mouse'], Laptop],
  [['phone', 'iphone', 'samsung', 'mobile'], Phone],
  [['watch', 'clock', 'timer'], Watch],
  [['game', 'controller', 'console', 'nintendo', 'playstation', 'xbox'], Gamepad2],
  [['fork', 'spoon', 'knife', 'utensil', 'silverware', 'cutlery'], Utensils],
  [['pot', 'pan', 'skillet', 'wok', 'cooker', 'kettle'], CookingPot],
  [['wine', 'glass', 'bottle', 'cup', 'mug'], Wine],
  [['chair', 'sofa', 'couch', 'furniture', 'table', 'desk'], Armchair],
  [['fan', 'heater', 'ac', 'air conditioner'], Fan],
  [['wrench', 'plier', 'socket'], Wrench],
  [['hammer', 'mallet', 'nail'], Hammer],
  [['scissor', 'cutter', 'tape'], Scissors],
  [['gift', 'present'], Gift],
  [['spice', 'pepper', 'salt', 'herb', 'seasoning', 'cinnamon'], Sparkles],
  [['bag', 'backpack', 'purse', 'suitcase'], ShoppingBag],
];

export function getItemIcon(itemName: string) {
  const lower = itemName.toLowerCase();
  for (const [keywords, Icon] of ICON_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) {
      return Icon;
    }
  }
  return Box; // Default fallback
}
