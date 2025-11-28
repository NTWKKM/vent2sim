/**
 * InfoTooltip Component
 * Reusable tooltip/info popup for education
 * Supports both hover and click modes
 */

export default function InfoTooltip({ 
  title, 
  description, 
  children, 
  position = 'top',
  className = '',
  onClick
}) {
  const [isVisible, setIsVisible] = React.useState(false);

  const positionClasses = {
    top: 'bottom-full mb-2',
    bottom: 'top-full mt-2',
    left: 'right-full mr-2',
    right: 'left-full ml-2'
  };

  return (
    <div className={`relative inline-block ${className}`}>
      {/* Trigger element */}
      <button
        type="button"
        className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-500 rounded-full hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-300"
        onClick={() => setIsVisible(!isVisible)}
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        aria-label={`Info: ${title}`}
      >
        ?
      </button>

      {/* Tooltip content */}
      {isVisible && (
        <div className={`
          absolute ${positionClasses[position]}
          z-50 w-64 p-3 bg-gray-900 text-white rounded-lg shadow-lg
          border border-gray-700 text-sm
          before:content-[''] before:absolute before:w-2 before:h-2 
          before:bg-gray-900 before:border-gray-700
          ${position === 'top' ? 'before:bottom-[-5px] before:left-4 before:border-t before:border-l' : ''}
          ${position === 'bottom' ? 'before:top-[-5px] before:left-4 before:border-b before:border-r' : ''}
        `}>
          {/* Title */}
          {title && (
            <h4 className="font-bold text-blue-300 mb-1">{title}</h4>
          )}

          {/* Description */}
          {description && (
            <p className="text-gray-200 text-xs mb-2 leading-relaxed">
              {description}
            </p>
          )}

          {/* Children (custom content) */}
          {children && (
            <div className="text-xs text-gray-300 border-t border-gray-700 pt-2 mt-2">
              {children}
            </div>
          )}

          {/* Close button */}
          <button
            onClick={() => setIsVisible(false)}
            className="mt-2 text-xs text-gray-400 hover:text-white"
          >
            ✕ Close
          </button>
        </div>
      )}
    </div>
  );
}
