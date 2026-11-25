/**
 * Skill taxonomy and normalization. Deterministic: "node.js", "NodeJS" and "Node" are one skill.
 *
 * Each line is `key | Display name | aliases (comma separated)`. Aliases starting with `=` are
 * only honoured when the WHOLE string is the skill (an explicit skill list), never when scanning
 * free text — "go", "r" and "c" are far too common as words.
 */
const TABLE = `
javascript | JavaScript | js, ecmascript, es6
typescript | TypeScript | ts
nodejs | Node.js | node, node.js, nodejs
react | React | react.js, reactjs
nextjs | Next.js | next.js, nextjs
vue | Vue.js | vue, vue.js, vuejs
angular | Angular | angularjs, angular.js
svelte | Svelte | sveltekit
html | HTML | html5
css | CSS | css3
sass | Sass | scss
tailwindcss | Tailwind CSS | tailwind
redux | Redux |
graphql | GraphQL |
rest | REST APIs | restful, rest api, rest apis, restful apis
python | Python | python3
django | Django |
flask | Flask |
fastapi | FastAPI |
java | Java | =jdk
spring | Spring | spring boot, springboot
kotlin | Kotlin |
swift | Swift | =swiftui
objectivec | Objective-C | objective-c, objc
csharp | C# | c#, c sharp
dotnet | .NET | .net, dotnet, .net core, asp.net core
aspnet | ASP.NET | asp.net
cpp | C++ | c++, cplusplus
c | C | =c
golang | Go | golang, =go
rust | Rust |
ruby | Ruby |
rails | Ruby on Rails | rails, ruby on rails
php | PHP |
laravel | Laravel |
scala | Scala |
r | R | =r
matlab | MATLAB |
bash | Bash | shell scripting, =shell, bash scripting
powershell | PowerShell |
sql | SQL |
postgresql | PostgreSQL | postgres, psql
mysql | MySQL | mariadb
sqlserver | SQL Server | mssql, ms sql, microsoft sql server
oracle | Oracle Database | oracle db
mongodb | MongoDB | mongo
redis | Redis |
elasticsearch | Elasticsearch | elastic search, opensearch
cassandra | Cassandra |
dynamodb | DynamoDB |
snowflake | Snowflake |
bigquery | BigQuery |
kafka | Apache Kafka | kafka
rabbitmq | RabbitMQ |
spark | Apache Spark | =spark, pyspark
hadoop | Hadoop |
airflow | Apache Airflow | airflow
dbt | dbt |
etl | ETL | etl pipelines, data pipelines
aws | AWS | amazon web services
azure | Azure | microsoft azure
gcp | Google Cloud | google cloud, google cloud platform
docker | Docker |
kubernetes | Kubernetes | k8s
terraform | Terraform |
ansible | Ansible |
jenkins | Jenkins |
cicd | CI/CD | ci/cd, ci cd, continuous integration, continuous delivery, continuous deployment
git | Git |
github | GitHub | github actions
gitlab | GitLab |
linux | Linux | unix
nginx | Nginx |
microservices | Microservices | microservice
machinelearning | Machine Learning | ml
deeplearning | Deep Learning |
nlp | NLP | natural language processing
computervision | Computer Vision |
tensorflow | TensorFlow |
pytorch | PyTorch |
pandas | pandas |
numpy | NumPy |
scikitlearn | scikit-learn | scikit-learn, sklearn
llm | LLMs | llms, large language models, generative ai
tableau | Tableau |
powerbi | Power BI | power bi, powerbi
excel | Microsoft Excel | =excel, ms excel
datavisualization | Data Visualization | data visualisation
statistics | Statistics |
android | Android |
ios | iOS |
reactnative | React Native |
flutter | Flutter |
dart | Dart |
unity | Unity |
selenium | Selenium |
cypress | Cypress |
playwright | Playwright |
jest | Jest |
junit | JUnit |
postman | Postman |
testautomation | Test Automation | automated testing, test automation
manualtesting | Manual Testing |
figma | Figma |
sketch | Sketch |
photoshop | Adobe Photoshop | photoshop
illustrator | Adobe Illustrator | illustrator
uiux | UI/UX Design | ui/ux, ux design, ui design, user experience, user interface design
agile | Agile | scrum, kanban
jira | Jira |
confluence | Confluence |
projectmanagement | Project Management |
productmanagement | Product Management |
seo | SEO | search engine optimization
sem | SEM | google ads, ppc
socialmedia | Social Media Marketing | social media
contentwriting | Content Writing | copywriting, content creation
emailmarketing | Email Marketing |
googleanalytics | Google Analytics |
crm | CRM | salesforce, hubspot
salesforce | Salesforce |
sap | SAP |
quickbooks | QuickBooks |
accounting | Accounting | bookkeeping
financialanalysis | Financial Analysis | financial modeling, financial modelling
cybersecurity | Cybersecurity | information security, infosec
penetrationtesting | Penetration Testing | pentesting
networking | Networking | tcp/ip
cisco | Cisco | ccna
communication | Communication | communication skills
leadership | Leadership |
problemsolving | Problem Solving | problem-solving
teamwork | Teamwork | collaboration
english | English | english language
urdu | Urdu |
`;

export interface SkillDef {
  key: string;
  name: string;
  /** Aliases safe to find in free text (lowercase). */
  textAliases: string[];
  /** Every alias, including those only valid for an explicit skill string. */
  allAliases: string[];
}

/** Dictionary words that are also skill names: honoured only in an explicit skill list. */
const AMBIGUOUS = [
  'go',
  'r',
  'c',
  'unity',
  'sketch',
  'excel',
  'spark',
  'shell',
  'swift',
  'node',
  'oracle',
];

const DEFS: SkillDef[] = TABLE.split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [key, name, aliasPart = ''] = line.split('|').map((part) => part.trim());
    const aliases = aliasPart
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    const textAliases = new Set<string>([
      name!.toLowerCase(),
      ...aliases.filter((a) => !a.startsWith('=')),
    ]);
    const allAliases = new Set<string>([
      key!,
      name!.toLowerCase(),
      ...aliases.map((a) => a.replace(/^=/, '')),
    ]);
    // Single-letter / dictionary-word names ("c", "r", "go") are not text aliases.
    for (const a of [...textAliases])
      if (a.length < 2 || AMBIGUOUS.includes(a)) textAliases.delete(a);
    return { key: key!, name: name!, textAliases: [...textAliases], allAliases: [...allAliases] };
  });

const BY_KEY = new Map(DEFS.map((d) => [d.key, d]));
const BY_ALIAS = new Map<string, SkillDef>();
for (const def of DEFS)
  for (const alias of def.allAliases) if (!BY_ALIAS.has(alias)) BY_ALIAS.set(alias, def);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-boundary matcher that also works for aliases made of symbols (c++, c#, .net, ci/cd). */
const MATCHERS = DEFS.filter((def) => def.textAliases.length > 0).map((def) => ({
  def,
  re: new RegExp(
    `(?<![A-Za-z0-9+#.])(?:${[...def.textAliases]
      .sort((a, b) => b.length - a.length)
      .map((a) => escapeRegex(a).replace(/\s+/g, '\\s+'))
      .join('|')})(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`,
    'i',
  ),
}));

/** Canonical key for an arbitrary skill string: taxonomy first, otherwise a stable slug. */
export function normalizeSkill(raw: string): { key: string; name: string; known: boolean } | null {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–•*·]+|[\s.,;:]+$/g, '')
    .trim();
  if (!cleaned || cleaned.length > 60) return null;
  const known = BY_ALIAS.get(cleaned.toLowerCase());
  if (known) return { key: known.key, name: known.name, known: true };
  const key = cleaned.toLowerCase().replace(/[^a-z0-9+#]/g, '');
  if (!key) return null;
  return { key, name: cleaned, known: false };
}

export const skillName = (key: string): string => BY_KEY.get(key)?.name ?? key;

export interface FoundSkill {
  key: string;
  name: string;
  /** Index of the first occurrence in the scanned text. */
  index: number;
}

/** Every taxonomy skill mentioned in `text`, in order of first appearance. */
export function findSkillsInText(text: string): FoundSkill[] {
  const found: FoundSkill[] = [];
  for (const { def, re } of MATCHERS) {
    const match = re.exec(text);
    if (match) found.push({ key: def.key, name: def.name, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Normalized, de-duplicated skill keys of an explicit list (project target skills). */
export function normalizeSkillList(list: string[]): { key: string; name: string }[] {
  const seen = new Map<string, { key: string; name: string }>();
  for (const raw of list) {
    const skill = normalizeSkill(raw);
    if (skill && !seen.has(skill.key)) seen.set(skill.key, { key: skill.key, name: skill.name });
  }
  return [...seen.values()];
}
