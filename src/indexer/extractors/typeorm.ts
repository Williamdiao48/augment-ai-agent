import type { OrmModel } from "../types.js";

const ENTITY_RE = /^\s*@(Entity|Table)\b/m;
const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m;
const FIELD_DECORATOR_RE =
  /@(Column|PrimaryColumn|PrimaryGeneratedColumn|ManyToOne|OneToMany|ManyToMany|OneToOne|JoinColumn|JoinTable|BelongsTo|HasMany|HasOne|BelongsToMany|ForeignKey|AllowNull|DataType|Unique|Default)\s*(?:\([^)]*\))?\s*\n\s+(\w+)/gm;

function detectFramework(content: string): "typeorm" | "sequelize" {
  if (content.includes("@Column") || content.includes("@Entity")) return "typeorm";
  return "sequelize";
}

export function extractTypeorm(content: string, sourceFile: string): OrmModel[] {
  if (!ENTITY_RE.test(content)) return [];

  const classMatch = content.match(CLASS_RE);
  if (!classMatch) return [];

  const fields = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(FIELD_DECORATOR_RE.source, "gm");
  while ((match = re.exec(content)) !== null) {
    fields.push({ name: match[2], decorator: match[1] });
  }

  return [
    {
      name: classMatch[1],
      fields,
      framework: detectFramework(content),
      sourceFile,
    },
  ];
}
