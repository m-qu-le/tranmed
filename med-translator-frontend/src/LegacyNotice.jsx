const NEW_APPLICATION_URL = 'https://tranmed-api.duckdns.org';

export default function LegacyNotice() {
  return (
    <main className="legacy-notice">
      <section>
        <p className="legacy-notice__eyebrow">StudyMed Translator</p>
        <h1>Ứng dụng đã chuyển địa chỉ</h1>
        <p>
          Hãy mở ứng dụng tại{' '}
          <a href={NEW_APPLICATION_URL}>{NEW_APPLICATION_URL}</a>.
        </p>
        <p className="legacy-notice__detail">
          Trang này không tự chuyển hướng và không kết nối tới hệ thống dịch.
        </p>
      </section>
    </main>
  );
}
