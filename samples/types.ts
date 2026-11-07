interface Shape {
  kind: "circle" | "square";
  size: number;
}

type Area<T extends Shape> = T extends { kind: "circle" } ? number : number;

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.size ** 2;
    case "square":
      return s.size * s.size;
  }
}

const shapes: Shape[] = [
  { kind: "circle", size: 2 },
  { kind: "square", size: 3 },
];

const total: number = shapes.reduce((sum, s) => sum + area(s), 0);
const wrong: string = total.toFixed(2);
console.log(total.toFixed(2), wrong);
