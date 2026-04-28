export type ProjectType =
  | "prisma"
  | "sql-migrations"
  | "django"
  | "typeorm"
  | "express"
  | "nextjs"
  | "fastapi"
  | "rails"
  | "typescript"
  | "graphql"
  | "docker"
  | "env"
  | "python"
  | "ruby";

export interface PrismaField {
  name: string;
  type: string;
  isOptional: boolean;
  isArray: boolean;
  isRelation: boolean;
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
}

export interface PrismaEnum {
  name: string;
  values: string[];
}

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlTable {
  tableName: string;
  columns: SqlColumn[];
  sourceFile: string;
}

export interface DjangoField {
  name: string;
  fieldType: string;
}

export interface DjangoModel {
  name: string;
  fields: DjangoField[];
}

export interface OrmField {
  name: string;
  decorator: string;
}

export interface OrmModel {
  name: string;
  fields: OrmField[];
  framework: "typeorm" | "sequelize";
  sourceFile: string;
}

export interface ExpressRoute {
  method: string;
  path: string;
  sourceFile: string;
}

export interface NextjsRoute {
  method: string;
  path: string;
  routerType: "app" | "pages";
}

export interface FastapiRoute {
  method: string;
  path: string;
  sourceFile: string;
}

export interface RailsRoute {
  method: string;
  path: string;
  action: string;
}

export interface TsMember {
  name: string;
  type: string;
}

export interface TsInterface {
  name: string;
  kind: "interface" | "type";
  members: TsMember[];
  sourceFile: string;
}

export interface GraphqlField {
  name: string;
  type: string;
}

export interface GraphqlType {
  keyword: string;
  name: string;
  fields: GraphqlField[];
}

export interface EnvKey {
  name: string;
  defaultValue: string | null;
  isSecret: boolean;
}

export interface DockerService {
  name: string;
  image: string;
  ports: string[];
  dependsOn: string[];
}

export interface FileTreeSummary {
  totalFiles: number;
  byExtension: Record<string, number>;
  topDirs: string[];
}

export interface DatabaseSchema {
  prismaModels: PrismaModel[];
  prismaEnums: PrismaEnum[];
  sqlTables: SqlTable[];
  djangoModels: DjangoModel[];
  typeormModels: OrmModel[];
}

export interface RouteList {
  express: ExpressRoute[];
  nextjs: NextjsRoute[];
  fastapi: FastapiRoute[];
  rails: RailsRoute[];
}

export interface TypeSchema {
  tsInterfaces: TsInterface[];
  graphqlTypes: GraphqlType[];
}

export interface ProjectIndex {
  projectRoot: string;
  detectedTypes: ProjectType[];
  db: DatabaseSchema;
  routes: RouteList;
  types: TypeSchema;
  env: EnvKey[];
  docker: DockerService[];
  fileTree: FileTreeSummary;
  builtAt: number;
}
