/**
 * DEFAULT_DOC_SETTINGS — Full schema default used as fallback when API returns nothing.
 * Asset URLs match the files present in /assets/ folder served by the backend.
 */
export const DEFAULT_DOC_SETTINGS = {
  company_id: 'DEFAULT',
  branding_assets: {
    header_image_url: '/assets/Expert  - Header.jpg',
    footer_image_url: '/assets/Footer - Expert (2025).PNG',
    company_stamp_url: '/assets/Stamp 2026.jpg',
    authorized_signature_url: '/assets/signature.svg',
    watermark_logo_url: '/assets/Watermark Logo.jpg'
  },
  document_configs: {
    SERVICE_REPORT: {
      show_header: true,
      show_footer: true,
      show_stamp_every_page: true,
      show_signature: true,
      show_amc_schedule: true,
      visible_columns: {
        mfg_year: true,
        refill_date: true,
        next_refill_due: true,
        hpt_date: true,
        hpt_due_date: true,
        client_id_no: true,
        location: true
      },
      enabled_checkpoints: {
        body_valve: true,
        safety_pin: true,
        pressure_gauge: true,
        hose_pipe: true,
        seal: true
      }
    },
    CERTIFICATE: {
      show_header: true,
      show_footer: true,
      show_stamp: true,
      show_signature: true,
      show_watermark: true,
      show_qr_code: true,
      visible_columns: {
        sr_no: true,
        item_name: true,
        capacity: true,
        qty: true,
        refill_date: true,
        valid_until: true
      }
    }
  }
};
