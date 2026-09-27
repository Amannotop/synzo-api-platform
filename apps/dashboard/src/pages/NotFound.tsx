import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export default function NotFound() {
  return (
    <div className="card">
      <EmptyState
        title="Page not found"
        message="That page does not exist in the dashboard."
        action={<Link className="btn btn-primary" to="/">Back to dashboard</Link>}
      />
    </div>
  );
}
