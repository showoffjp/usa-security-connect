import { downloadFile } from '../lib/api.js';
import { AuthedImage } from './AuthedImage.jsx';
import { Icon, Modal, useToast } from './ui.jsx';

/** The receipt behind an expense claim: a photo shown, a PDF downloaded. */
export function ReceiptView({ claim, onClose }) {
  const toast = useToast();
  const src = `/expenses/${claim.id}/receipt`;
  const download = () =>
    downloadFile(src, `receipt-${claim.id}.${claim.receipt_pdf ? 'pdf' : 'jpg'}`).catch((err) => toast.error(err.message));
  return (
    <Modal
      title={`Receipt: ${claim.category_label}, $${claim.amount.toFixed(2)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={download}>
            <Icon name="download" size={16} /> Download
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {claim.receipt_pdf ? (
        <div className="small muted">This receipt is a PDF. Download it to read it.</div>
      ) : (
        <div className="receipt-view">
          <AuthedImage src={src} alt={`Receipt for ${claim.description}`} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto' }} />
        </div>
      )}
    </Modal>
  );
}
