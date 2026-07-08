import { atom, register, useValue } from "../src/index";

register();
const count = atom(0);
const increment = () => count.update((value) => value + 1);
const double = () => count.update((value) => value * 2);

export default {
  useCount: () => useValue(count),
  useIncrement: () => increment,
  useDouble: () => double,
};
