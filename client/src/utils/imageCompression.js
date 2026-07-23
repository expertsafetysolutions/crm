/**
 * Client-side Image Compression using HTML5 Canvas
 * Ensures output Base64 string is < 200KB
 *
 * @param {File} file - Image File selected by user
 * @param {number} maxDimension - Max width/height in pixels (default 800)
 * @param {number} targetSizeBytes - Target size in bytes (default 180000 bytes ~ 180KB)
 * @returns {Promise<string>} Base64 data URL
 */
export function compressImageToDataURL(file, maxDimension = 800, targetSizeBytes = 180000) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Iteratively reduce JPEG quality until size < targetSizeBytes
        let quality = 0.8;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);

        while (dataUrl.length > targetSizeBytes && quality > 0.2) {
          quality -= 0.15;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }

        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}
