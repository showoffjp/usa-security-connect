import { useDemo } from '../lib/demo.js';

/**
 * A strip across every page of the self-contained demo, so nobody takes it for
 * the real system: its data is sample data, and changes are not kept.
 */
export default function DemoStrip() {
  const demo = useDemo();
  if (!demo) return null;
  return (
    <div className="demo-strip" role="note">
      <strong>Demo site</strong> · sample company and people. Changes you make here are not kept. <a href="/tour/">Take the product tour</a>
    </div>
  );
}
