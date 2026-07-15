import "./ConfirmDialog.css";

type Props = {
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
};

export default function ConfirmDialog({

    open,

    title,

    message,

    confirmText = "OK",

    cancelText = "Cancel",

    danger = false,

    onConfirm,

    onCancel

}: Props) {

    if (!open) {

        return null;

    }

    return (

        <div
            className="confirm-overlay"
            onClick={onCancel}
        >

            <div
                className="confirm-modal"
                onClick={(e) => e.stopPropagation()}
            >

                <h2>{title}</h2>

                <p>{message}</p>

                <div className="confirm-actions">

                    <button
                        className="confirm-cancel"
                        onClick={onCancel}
                    >
                        {cancelText}
                    </button>

                    <button
                        className={
                            danger
                                ? "confirm-delete"
                                : "confirm-primary"
                        }
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </button>

                </div>

            </div>

        </div>

    );

}