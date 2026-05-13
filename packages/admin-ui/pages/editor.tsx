// pages/editor.tsx
import dynamic from 'next/dynamic';
import { useEffect } from 'react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const yamlSchema = {
  uri: '/api/rule-pack-schema',
  fileMatch: ['*.yaml', '*.yml'],
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['id']
        }
      }
    },
    required: ['name', 'version']
  }
};

export default function EditorPage() {
  useEffect(() => {
    // Register yaml schema when monaco loads
    const monaco = (global as any).monaco;
    if (monaco) {
      monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions({
        enableSchemaRequest: true,
        schemas: [yamlSchema]
      });
    }
  }, []);

  return (
    <div className="p-4 h-screen bg-gray-900 text-white">
      <h1 className="text-2xl mb-4">Rule Pack YAML Editor</h1>
      <MonacoEditor
        height="80vh"
        defaultLanguage="yaml"
        defaultValue="# Start editing your rule pack YAML here"
        theme="vs-dark"
        onMount={(editor, monaco) => {
          // Monaco doesn't ship YAML diagnostics by default — guard the call
          // so the bundle compiles even if monaco-yaml isn't installed.
          const langs = monaco.languages as unknown as {
            yaml?: { yamlDefaults?: { setDiagnosticsOptions: (opts: unknown) => void } };
          };
          langs.yaml?.yamlDefaults?.setDiagnosticsOptions({
            enableSchemaRequest: true,
            schemas: [yamlSchema],
          });
        }}
      />
    </div>
  );
}
