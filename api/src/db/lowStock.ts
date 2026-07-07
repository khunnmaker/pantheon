import { Prisma } from '@prisma/client';

// The "low stock" predicate is a column-vs-column compare (stock <= reorderPoint) that can't be
// expressed as a Prisma filter, so it lived as hand-copied raw SQL in 4 places (Vulcan dashboard
// count + list, Mercury reorder queue, Jupiter badge). One definition here = they can never
// silently disagree when the rule changes. Interpolate inside a $queryRaw template:
//   prisma.$queryRaw`SELECT ... FROM "Product" WHERE ${LOW_STOCK_WHERE}`
export const LOW_STOCK_WHERE = Prisma.sql`status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL AND stock <= "reorderPoint"`;

// The reorder priority order (most-urgent first), shared by the stock list + the reorder queue.
export const LOW_STOCK_ORDER = Prisma.sql`ORDER BY (stock::float / NULLIF("reorderPoint", 0)) ASC NULLS FIRST, stock ASC`;
